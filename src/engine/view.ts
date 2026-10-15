// Projection: the files a closed set of atoms produces. A pure function of the
// set. Each file is a tree of lines hanging off its start node; linearizing it
// depth-first, children in descending priority, gives the file's sequence. A
// line hangs off the node it was written after, unless a move in the set gave
// it another parent (#28): then the newest such move decides.
//
// A laid-out file is kept as arrays of line numbers (the graph's n), not as a
// record per line (#46): a record, its id and two index entries cost about
// 370 bytes a line, and the view cache holds up to 200,000 lines. Records are
// made when a caller asks for them, and the latest asked for is kept.

import type { Graph, RelocationInfo } from "./graph.ts";
import { isStartNode, seqOf } from "./keys.ts";
import { resolveScratchMoves, scratchLayoutNodes } from "./relocation-scratch.ts";
import { isClosedSet, StableSet } from "./state-source.ts";
import { joinLines } from "./text.ts";
import { type AtomId, type AtomSet, EngineError, type LineId, type NodeId } from "./types.ts";

/** A line in a file's full sequence, tombstones included. */
export interface SeqLine {
	readonly id: LineId;
	readonly text: string;
	/** The atom that wrote it. */
	readonly atom: AtomId;
	/** Atoms in the set that delete it, by seq. Empty when it is visible. */
	readonly deletedBy: readonly AtomId[];
	readonly visible: boolean;
}

/** A visible line of a projected file. */
export interface VisibleLine {
	readonly textChunks?: () => Iterable<string>;
	readonly id: LineId;
	readonly text: string;
	readonly atom: AtomId;
}

/** A file's attributes in a view. */
export interface FileAttrs {
	/** Kept with no lines (an empty file). */
	readonly exists: boolean;
	readonly exec: boolean;
	/** The target, when the file is a symbolic link. */
	readonly link: string | null;
	/** The SHA-256 of its bytes, when the file is binary. */
	readonly blob: string | null;
}

/** Structural read boundary shared by historical and transaction-bound projections. */
export type ReadView = Omit<
	Pick<View, keyof View>,
	"sameText" | "visibleCount" | "shareMoves" | "fileOfNumber" | "lineNumberOf" | "visibleWriters"
> & {
	sameText(path: string, other: ReadView): boolean;
};

const NO_ATTRS: FileAttrs = { exists: false, exec: false, link: null, blob: null };
const NONE: readonly never[] = Object.freeze([]);

interface FileState {
	readonly attrs: FileAttrs;
	/** Full history is retained only when a sequence caller explicitly requests it. */
	readonly complete: boolean;
	/** The file's sequence, tombstones included: each line's n. */
	readonly seq: Int32Array;
	/** Its visible lines' n, in order. */
	readonly vis: Int32Array;
	/** For each deleted position in seq: the seqs of the atoms in the set that delete it, by priority. */
	readonly deletedBy: ReadonlyMap<number, readonly number[]>;
	/** Its visible lines' text, when laid out from the file's packed history: null for a line too long to pack. */
	readonly visText?: readonly (string | null)[];
	/** Positions by n, built the first time they're asked for. */
	seqIndex?: Map<number, number>;
	visIndex?: Map<number, number>;
}

interface Child {
	readonly n: number;
	/** 1 when the child's atom deleted the parent (the child replaces it), else 0. A moved line is 0. */
	readonly replaces: number;
	readonly lamport: number;
	readonly seq: number;
	readonly k: number;
}

const EMPTY_INTS = new Int32Array(0);
const NO_FILE: FileState = { attrs: NO_ATTRS, complete: true, seq: EMPTY_INTS, vis: EMPTY_INTS, deletedBy: new Map() };

// Approximate retained-container costs for View.weight(): reference slots,
// object headers, and map/set entries. These are cache-budget units, not V8
// heap measurements. Referenced Graph strings and records are not charged.
const ARRAY_HEADER_BYTES = 24;
const OBJECT_BYTES = 32;
const MAP_HEADER_BYTES = 32;
const MAP_ENTRY_BYTES = 40;
const SET_ENTRY_BYTES = 32;
const REFERENCE_BYTES = 8;
/**
 * Moved lines a view resolves once and keeps (abso Capacity): a stored graph otherwise resolved every move again on
 * disk for each file it laid out. Game's whole history has 290; past this many, the view goes back to that.
 */
export const MOVED_LINES_KEPT = 20_000;
class TooManyMoves extends Error {}
const NO_LINES: readonly number[] = Object.freeze([]);
/** Nodes whose nearest moved line above a graph remembers, at most: about 40 bytes each. */
const CLIMB_MEMO = 200_000;

/** One relocation of a moved line, with its line's number and its new parent's code. */
interface MoveEntry {
	readonly n: number;
	readonly r: RelocationInfo;
	readonly parent: number;
}

/**
 * A graph's moves, whatever the set (abso Capacity): each mover's moved lines, each moved line's relocations in seq
 * order, and for any node the nearest node at or above it, by where lines were written, that a move ever relocated,
 * or its file's start. Worked out once per graph and extended as it grows. A view's moves then resolve over the moved
 * lines alone: before, every view walked each moved line's file up to its start, a read per line.
 */
class MoveSkeleton {
	readonly #graph: Graph;
	#seen = 0;
	/** Movers in seq order, with the numbers of the lines each moves, in its moves' order. */
	readonly movers: { readonly seq: number; readonly lines: readonly number[] }[] = [];
	/** Every relocation of each moved line, by the line's number, in seq order. */
	readonly byLine = new Map<number, MoveEntry[]>();
	readonly #climbed = new Map<number, number>();

	constructor(graph: Graph) {
		this.#graph = graph;
	}

	/** Take in movers the graph gained since. */
	update(): this {
		const graph = this.#graph;
		const all = graph.movers();
		if (this.#seen === all.length) return this;
		for (; this.#seen < all.length; this.#seen++) {
			const id = all[this.#seen]!;
			const lines: number[] = [];
			graph.atom(id).moves!.forEach((m, k) => {
				const n = graph.lineN(m.line);
				const r: RelocationInfo = Object.freeze({ atom: id, line: m.line, parent: m.parent, k });
				const entry: MoveEntry = { n, r, parent: graph.codeOf(m.parent)! };
				const list = this.byLine.get(n);
				if (list) list.push(entry);
				else this.byLine.set(n, [entry]);
				lines.push(n);
			});
			this.movers.push({ seq: seqOf(id), lines });
		}
		// A new moved line can sit between a node and the one it climbed to.
		this.#climbed.clear();
		return this;
	}

	/** The nearest node at or above this one, by where lines were written, that a move ever relocated; or its file's start. */
	climb(code: number): number {
		const walked: number[] = [];
		let c = code;
		while (c >= 0 && !this.byLine.has(c)) {
			const known = this.#climbed.get(c);
			if (known !== undefined) {
				c = known;
				break;
			}
			walked.push(c);
			c = this.#graph.parentCodeOf(c);
		}
		if (this.#climbed.size + walked.length > CLIMB_MEMO) this.#climbed.clear();
		for (const w of walked) this.#climbed.set(w, c);
		return c;
	}
}

const skeletons = new WeakMap<Graph, MoveSkeleton>();
function skeletonOf(graph: Graph): MoveSkeleton {
	let skeleton = skeletons.get(graph);
	if (!skeleton) skeletons.set(graph, (skeleton = new MoveSkeleton(graph)));
	return skeleton.update();
}

/**
 * The projection of a closed set. Construct once, then ask for files, lines
 * and sequences. Throws `not-closed` if some atom's dependency is missing.
 * Each file is laid out the first time it is asked for, so a view of a large
 * set costs little until files are read.
 */
export class View {
	readonly graph: Graph;
	/** The set, made from #in the first time it's asked for: a view keeps a byte per atom, not a copy of the set (#46). */
	#set: AtomSet | undefined;
	readonly #stable: StableSet<AtomId> | undefined;
	/** Fixed-size memo for immutable indexed membership, independent of history size. */
	#membershipSeq = new Float64Array(256).fill(-1);
	#membershipValue = new Uint8Array(256);
	#files = new Map<string, FileState>();
	/** Every file the set wrote in, sorted; worked out the first time it's asked for. */
	#knownList: string[] | undefined;
	/** 1 for each atom (by seq) in the set. */
	#in: Uint8Array;
	/** Atoms in the set that move lines. */
	#movers: AtomId[] | undefined;
	#hasMoves = false;
	/** Each moved line's relocation that counts in this set; built on first use. */
	#relocs: Map<LineId, RelocationInfo> | undefined;
	/** The same, by n, with the new parent's code. */
	#relocsN: Map<number, { readonly r: RelocationInfo; readonly parent: number }> | undefined;
	/** The moved lines under each node, by its code, made from the relocations on first use. */
	#movedInto: Map<number, number[]> | undefined;
	/** Whether this view's moves are too many to keep, so they're resolved on disk per layout; undefined until asked. */
	#movesOnDisk: boolean | undefined;
	/** The latest records asked for: one file's lines, one file's sequence, one file's text. */
	#linesCache: { path: string; lines: readonly VisibleLine[] } | undefined;
	#seqCache: { path: string; seq: readonly SeqLine[] } | undefined;
	#textCache: { path: string; text: string } | undefined;

	constructor(graph: Graph, set: Iterable<AtomId>) {
		this.graph = graph;
		if (set instanceof StableSet) {
			this.#stable = set;
			this.#set = set;
			this.#in = new Uint8Array(0);
			// A set kept closed when it was written needs no proof here (abso Capacity).
			for (const id of isClosedSet(set) ? [] : set) {
				const atom = graph.atom(id);
				for (const dependency of atom.deps) {
					graph.atom(dependency);
					if (!set.has(dependency))
						throw new EngineError("not-closed", `set is not closed: ${id} depends on ${dependency}`);
				}
			}
			for (const id of graph.movers()) {
				if (set.has(id)) {
					this.#hasMoves = true;
					break;
				}
			}
			this.#relocs = this.#hasMoves ? undefined : new Map();
			this.#relocsN = this.#hasMoves ? undefined : new Map();
			return;
		}
		const inSet = new Uint8Array(graph.size);
		for (const id of set) {
			const atom = graph.atom(id);
			inSet[atom.seq] = 1;
		}
		// Validate one atom at a time. Keeping all decoded atoms here defeats
		// storage-backed Graph reads even though the view only needs membership.
		for (let seq = 0; seq < inSet.length; seq++) {
			if (inSet[seq] !== 1) continue;
			const atom = graph.atom(graph.idOfSeq(seq));
			for (const d of atom.deps) {
				if (inSet[graph.atom(d).seq] !== 1)
					throw new EngineError("not-closed", `set is not closed: ${atom.id} depends on ${d}`);
			}
		}
		this.graph = graph;
		this.#in = inSet;
		this.#movers = graph.movers().filter((id) => inSet[graph.atom(id).seq] === 1);
		this.#hasMoves = this.#movers.length > 0;
		this.#relocs = this.#movers.length === 0 ? new Map() : undefined;
		this.#relocsN = this.#movers.length === 0 ? new Map() : undefined;
	}

	/** The set of atoms this view projects. */
	get set(): AtomSet {
		if (!this.#set) {
			const out = new Set<AtomId>();
			for (let seq = 0; seq < this.#in.length; seq++) if (this.#in[seq] === 1) out.add(this.graph.idOfSeq(seq));
			this.#set = out;
		}
		return this.#set;
	}

	/** Whether the atom with this seq is in the set. */
	#has(seq: number): boolean {
		if (this.#stable) {
			const slot = seq % this.#membershipSeq.length;
			if (this.#membershipSeq[slot] === seq) return this.#membershipValue[slot] === 1;
			const present = this.#stable.has(this.graph.idOfSeq(seq));
			this.#membershipSeq[slot] = seq;
			this.#membershipValue[slot] = present ? 1 : 0;
			return present;
		}
		return seq < this.#in.length && this.#in[seq] === 1;
	}

	/**
	 * The relocation that counts for each moved line: the newest (by priority)
	 * in the set. Two moves made apart can loop lines into each other, so no
	 * start node reaches them; then the oldest relocation on the loop is
	 * ignored, and the next newest of that line counts, until none loop.
	 */
	#relocations(): Map<LineId, RelocationInfo> {
		if (this.#relocs) return this.#relocs;
		const graph = this.graph;
		const skeleton = skeletonOf(graph);
		const stronger = (a: RelocationInfo, b: RelocationInfo): boolean => graph.comparePriority(a.atom, b.atom) > 0;
		const identity = (r: RelocationInfo): string => JSON.stringify([r.atom, r.k]);
		const ignored = new Set<string>();
		const pick = (n: number): MoveEntry | undefined => {
			let best: MoveEntry | undefined;
			for (const e of skeleton.byLine.get(n) ?? []) {
				if (this.#has(seqOf(e.r.atom)) && !ignored.has(identity(e.r)) && (!best || stronger(e.r, best.r))) best = e;
			}
			return best;
		};
		// By the moved line's number, in the order its movers come (seq order, then each mover's moves).
		const relocs = new Map<number, MoveEntry>();
		for (const mover of skeleton.movers) {
			if (!this.#has(mover.seq)) continue;
			for (const n of mover.lines) {
				if (!relocs.has(n)) relocs.set(n, pick(n)!);
				if (graph.hasOrderedChildren && relocs.size > MOVED_LINES_KEPT) throw new TooManyMoves();
			}
		}
		// From a node, the next node that matters for loops: a line moved in this set, or a file's start.
		const hop = (code: number): number => {
			let c = skeleton.climb(code);
			while (c >= 0 && !relocs.has(c)) c = skeleton.climb(graph.parentCodeOf(c));
			return c;
		};
		const step = (n: number): number => {
			const e = relocs.get(n);
			return hop(e ? e.parent : graph.parentCodeOf(n));
		};
		// Two moves made apart can loop lines into each other, so no start node reaches them; then the oldest
		// relocation on the loop is ignored, and the next newest of that line counts, until none loop.
		const reaches = new Set<number>();
		for (const line of [...relocs.keys()]) {
			for (;;) {
				const path: number[] = [];
				const onPath = new Map<number, number>();
				let cur = line;
				let loopAt = -1;
				while (cur >= 0 && !reaches.has(cur)) {
					const at = onPath.get(cur);
					if (at !== undefined) {
						loopAt = at;
						break;
					}
					onPath.set(cur, path.length);
					path.push(cur);
					cur = step(cur);
				}
				if (loopAt < 0) {
					for (const l of path) reaches.add(l);
					break;
				}
				let weakest: MoveEntry | undefined;
				for (const l of path.slice(loopAt)) {
					const e = relocs.get(l);
					if (e && (!weakest || stronger(weakest.r, e.r))) weakest = e;
				}
				ignored.add(identity(weakest!.r));
				const next = pick(weakest!.n);
				if (next) relocs.set(weakest!.n, next);
				else relocs.delete(weakest!.n);
			}
		}
		this.#relocsN = new Map([...relocs].map(([n, e]) => [n, { r: e.r, parent: e.parent }]));
		this.#relocs = new Map([...relocs.values()].map((e) => [e.r.line, e.r]));
		return this.#relocs;
	}

	/**
	 * Take another view's resolved moves (abso Capacity), when both sets hold the very same atoms that move lines: the
	 * moves then resolve the same, and every line sits where it sits there. Checked here, so any caller may ask.
	 */
	shareMoves(from: View): void {
		if (from.graph !== this.graph || from.#hasMoves !== this.#hasMoves || !this.#hasMoves) return;
		if (this.#relocs || from.#scratchMoves()) return;
		for (const id of this.graph.movers()) {
			const seq = seqOf(id);
			if (this.#has(seq) !== from.#has(seq)) return;
		}
		this.#relocs = from.#relocations();
		this.#relocsN = from.#relocationsN();
		this.#movesOnDisk = false;
		this.#movedFrom = from.#movedInFrom();
	}

	/** Whether moves are resolved on disk for each layout: only a stored graph's view with more than MOVED_LINES_KEPT. */
	#scratchMoves(): boolean {
		if (!this.#hasMoves || !this.graph.hasOrderedChildren) return false;
		if (this.#movesOnDisk === undefined) {
			try {
				this.#relocations();
				this.#movesOnDisk = false;
			} catch (error) {
				if (!(error instanceof TooManyMoves)) throw error;
				this.#movesOnDisk = true;
			}
		}
		return this.#movesOnDisk;
	}

	/** The relocations by n, with each new parent's code. */
	#relocationsN(): Map<number, { readonly r: RelocationInfo; readonly parent: number }> {
		if (this.#relocsN) return this.#relocsN;
		const out = new Map<number, { readonly r: RelocationInfo; readonly parent: number }>();
		for (const [line, r] of this.#relocations())
			out.set(this.graph.lineN(line), { r, parent: this.graph.codeOf(r.parent)! });
		this.#relocsN = out;
		return out;
	}

	/** The node a line hangs off in this set: where it was written, or where a move put it. */
	parentOf(line: LineId): NodeId {
		if (this.graph.lineParent(line) === undefined) throw new EngineError("unknown-line", `no line ${line}`);
		if (this.#scratchMoves())
			return this.graph.withProjectionScratch((scratch) =>
				resolveScratchMoves(this.graph, (id) => this.#has(this.graph.atom(id).seq), scratch).parent(line),
			);
		const r = this.#hasMoves ? this.#relocations().get(line) : undefined;
		if (r) return r.parent;
		const parent = this.graph.lineParent(line);
		if (parent === undefined) throw new EngineError("unknown-line", `no line ${line}`);
		return parent;
	}

	/** Whether any atom in the set moves lines. */
	hasMoves(): boolean {
		return this.#hasMoves;
	}
	*#eachMover(): IterableIterator<AtomId> {
		if (this.#movers) yield* this.#movers;
		else for (const id of this.graph.movers()) if (this.#stable!.has(id)) yield id;
	}

	/** The file a line is in, in this set: the one its chain of parents reaches. */
	fileOf(line: LineId): string {
		const n = this.graph.lineN(line);
		if (n < 0) throw new EngineError("unknown-line", `no line ${line}`);
		return this.#fileOfN(n);
	}

	#fileOfN(n: number): string {
		const graph = this.graph;
		if (!this.#hasMoves) return graph.writtenIn(n);
		if (this.#scratchMoves())
			return graph.withProjectionScratch((scratch) => {
				const moves = resolveScratchMoves(graph, (id) => this.#has(graph.atom(id).seq), scratch);
				let current = graph.nodeOf(n);
				while (!isStartNode(current)) current = moves.parent(current);
				return current.slice(1);
			});
		return this.#fileOfCode(n);
	}

	/** The file a node sits in, in this set: up by where lines were written, through the moves that count here. */
	#fileOfCode(code: number): string {
		const graph = this.graph;
		const relocs = this.#relocationsN();
		const skeleton = skeletonOf(graph);
		let c = code;
		for (;;) {
			c = skeleton.climb(c);
			if (c < 0) return graph.nodeOf(c).slice(1);
			const e = relocs.get(c);
			c = e ? e.parent : graph.parentCodeOf(c);
		}
	}

	/** The lines hanging off a node in this set, in layout order. */
	#children(code: number): Child[] {
		const graph = this.graph;
		const relocs = this.#hasMoves ? this.#relocationsN() : undefined;
		const out: Child[] = [];
		for (const n of graph.eachChildN(code)) {
			const seq = graph.writerSeqOf(n);
			if (!this.#has(seq) || relocs?.has(n)) continue;
			out.push({ n, replaces: graph.replacesN(n) ? 1 : 0, lamport: graph.lamportOfSeq(seq), seq, k: graph.kOf(n) });
		}
		if (relocs) {
			// The lines this set's moves put under each node, from the moves it already resolved: no row read per node
			// (abso Capacity).
			if (!this.#movedInto) {
				this.#movedInto = new Map();
				for (const [n, { parent }] of relocs) {
					const into = this.#movedInto.get(parent);
					if (into) into.push(n);
					else this.#movedInto.set(parent, [n]);
				}
			}
			for (const n of this.#movedInto.get(code) ?? NO_LINES) {
				const r = relocs.get(n)!.r;
				const seq = graph.atom(r.atom).seq;
				out.push({ n, replaces: 0, lamport: graph.lamportOfSeq(seq), seq, k: r.k });
			}
		}
		// A line's replacements (runs of atoms that deleted it) first, then the
		// rest; each group in descending priority (lamport, then seq); lines of
		// one atom keep k order. A replacement already outranks every insertion
		// after the line that reads it (it depends on them, or conflicts with
		// them); the grouping also puts it above a `before` insertion, which
		// doesn't read the line above, so the new text lands in the replaced
		// line's place. A moved line ranks like an insertion by the moving atom.
		if (out.length > 1)
			out.sort((a, b) => b.replaces - a.replaces || b.lamport - a.lamport || b.seq - a.seq || a.k - b.k);
		return out;
	}

	/** Parent/successor traversal keeps no history-sized ancestry or sibling frontier. */
	*#layoutNodes(start: number): IterableIterator<number> {
		const graph = this.graph;
		if (graph.hasOrderedChildren && !this.#hasMoves) {
			const first = (parent: number, after?: number): number | undefined => {
				for (const n of graph.orderedChildrenN(parent, after)) if (this.#has(graph.writerSeqOf(n))) return n;
				return undefined;
			};
			let n = first(start);
			while (n !== undefined) {
				yield n;
				const child = first(n);
				if (child !== undefined) {
					n = child;
					continue;
				}
				let previous = n;
				for (;;) {
					const parent = graph.parentCodeOf(previous);
					const sibling = first(parent, previous);
					if (sibling !== undefined) {
						n = sibling;
						break;
					}
					if (parent === start) {
						n = undefined;
						break;
					}
					if (parent < 0 || parent >= previous) throw new Error("invalid persistent layout ancestry");
					previous = parent;
				}
			}
			return;
		}
		const stack: number[] = [];
		const push = (parent: number): void => {
			const children = this.#children(parent);
			for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!.n);
		};
		push(start);
		while (stack.length) {
			const n = stack.pop()!;
			yield n;
			push(n);
		}
	}

	/** Lay out one file: its line tree from the set's atoms, linearized. */
	#layout(path: string, complete: boolean): FileState {
		const graph = this.graph;
		if (graph.packedFiles && !this.#scratchMoves()) return this.#layoutPacked(path, complete);
		if (this.#scratchMoves())
			return graph.withProjectionScratch((scratch) =>
				this.#layoutResolved(
					path,
					complete,
					scratchLayoutNodes(graph, (id) => this.#has(graph.atom(id).seq), scratch, `^${path}`),
				),
			);
		return this.#layoutResolved(path, complete);
	}

	/** For each path, the files that lines moved into it were written in: worked out once per view. */
	#movedFrom: Map<string, Set<number>> | undefined;
	#movedInFrom(): Map<string, Set<number>> {
		if (this.#movedFrom) return this.#movedFrom;
		const graph = this.graph;
		const out = new Map<string, Set<number>>();
		if (this.#hasMoves) {
			const relocs = this.#relocationsN();
			const fileOf = (code: number): string => this.#fileOfCode(code);
			for (const [n, { parent }] of relocs) {
				const into = fileOf(parent);
				let from = out.get(into);
				if (!from) out.set(into, (from = new Set()));
				from.add(graph.writtenInIndex(n));
			}
		}
		this.#movedFrom = out;
		return out;
	}

	/**
	 * Lay one file out from its packed history (abso Capacity, Graph.packedLines): the lines written in it, and in the
	 * files its moved-in lines came from, read a page at a time; the same tree and order as #layoutResolved, built in
	 * memory with no read per line.
	 */
	#layoutPacked(path: string, complete: boolean): FileState {
		const graph = this.graph;
		const attrs = this.#attributes(path);
		const start = graph.startCodeOf(path);
		if (start === undefined) return { attrs, complete, seq: EMPTY_INTS, vis: EMPTY_INTS, deletedBy: new Map() };
		const relocs = this.#hasMoves ? this.#relocationsN() : undefined;
		const files = new Set<number>([-1 - start, ...(this.#movedInFrom().get(path) ?? [])]);
		const children = new Map<number, Child[]>();
		const texts = new Map<number, string | null>();
		const deleters = new Map<number, number[]>();
		for (const file of files) {
			const lineTexts = graph.packedTexts(file);
			for (const [n, parent, seq, k, replaces] of graph.packedLines(file)) {
				const text = lineTexts.next().value as string | null;
				if (!this.#has(seq)) continue;
				const moved = relocs?.get(n);
				let at = parent;
				let child: Child = { n, replaces, lamport: graph.lamportOfSeq(seq), seq, k };
				if (moved) {
					const mover = graph.atom(moved.r.atom).seq;
					child = { n, replaces: 0, lamport: graph.lamportOfSeq(mover), seq: mover, k: moved.r.k };
					at = moved.parent;
				}
				const list = children.get(at);
				if (list) list.push(child);
				else children.set(at, [child]);
				texts.set(n, text);
			}
			for (const [n, deleter] of graph.packedDeletes(file)) {
				if (!this.#has(deleter)) continue;
				const by = deleters.get(n);
				if (by) by.push(deleter);
				else deleters.set(n, [deleter]);
			}
		}
		const order = (a: Child, b: Child) =>
			b.replaces - a.replaces || b.lamport - a.lamport || b.seq - a.seq || a.k - b.k;
		const priority = (a: number, b: number) => graph.lamportOfSeq(a) - graph.lamportOfSeq(b) || a - b;
		const seq: number[] = [];
		const vis: number[] = [];
		const visText: (string | null)[] = [];
		const deletedBy = new Map<number, readonly number[]>();
		const stack: number[] = [];
		const push = (code: number) => {
			const list = children.get(code);
			if (!list) return;
			if (list.length > 1) list.sort(order);
			for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]!.n);
		};
		push(start);
		while (stack.length) {
			const n = stack.pop()!;
			const by = deleters.get(n);
			if (by) {
				if (complete) deletedBy.set(seq.length, by.length > 1 ? by.sort(priority) : by);
			} else {
				vis.push(n);
				visText.push(texts.get(n) ?? null);
			}
			if (complete) seq.push(n);
			push(n);
		}
		return { attrs, complete, seq: Int32Array.from(seq), vis: Int32Array.from(vis), deletedBy, visText };
	}

	#attributes(path: string): FileAttrs {
		const graph = this.graph;
		// For each attribute, the highest-priority setter in the set wins.
		const setters = new Map<string, { id: AtomId; value: string | null }>();
		const file = graph.packedFiles ? graph.pathIndexOf(path) : undefined;
		if (graph.packedFiles) {
			for (const [seq, name, value] of file === undefined ? [] : graph.packedAttrs(file)) {
				if (!this.#has(seq)) continue;
				const id = graph.idOfSeq(seq);
				const best = setters.get(name);
				if (!best || graph.comparePriority(best.id, id) < 0) setters.set(name, { id, value });
			}
			return {
				exists: setters.get("exists")?.value === "1",
				exec: setters.get("exec")?.value === "1",
				link: setters.get("link")?.value ?? null,
				blob: setters.get("blob")?.value ?? null,
			};
		}
		for (const id of graph.eachAtomIn(path)) {
			if (!this.#has(graph.atom(id).seq)) continue;
			for (const a of graph.atom(id).attrs ?? []) {
				if (a.file !== path) continue;
				const best = setters.get(a.name);
				if (!best || graph.comparePriority(best.id, id) < 0) setters.set(a.name, { id, value: a.value });
			}
		}

		return {
			exists: setters.get("exists")?.value === "1",
			exec: setters.get("exec")?.value === "1",
			link: setters.get("link")?.value ?? null,
			blob: setters.get("blob")?.value ?? null,
		};
	}

	#layoutResolved(path: string, complete: boolean, nodes?: Iterable<number>): FileState {
		const graph = this.graph;
		const attrs = this.#attributes(path);
		const seq: number[] = [];
		const vis: number[] = [];
		const deletedBy = new Map<number, readonly number[]>();

		const start = graph.startCodeOf(path);
		const priority = (a: number, b: number) => graph.lamportOfSeq(a) - graph.lamportOfSeq(b) || a - b;
		for (const n of nodes ?? (start === undefined ? [] : this.#layoutNodes(start))) {
			let deleted = false;
			const by: number[] = [];
			for (const deleter of graph.eachDeleterSeqOf(n)) {
				if (!this.#has(deleter)) continue;
				deleted = true;
				if (!complete) break;
				by.push(deleter);
			}
			if (deleted) {
				if (complete) deletedBy.set(seq.length, by.length > 1 ? by.sort(priority) : by);
			} else vis.push(n);
			if (complete) seq.push(n);
		}

		return { attrs, complete, seq: Int32Array.from(seq), vis: Int32Array.from(vis), deletedBy };
	}

	get #known(): string[] {
		if (!this.#knownList) {
			const known = new Set<string>();
			if (this.#stable) {
				for (const id of this.#stable) for (const file of this.graph.filesOf(id)) known.add(file);
			} else {
				for (let seq = 0; seq < this.#in.length; seq++)
					if (this.#in[seq] === 1) for (const file of this.graph.filesOf(this.graph.idOfSeq(seq))) known.add(file);
			}
			this.#knownList = [...known].sort();
		}
		return this.#knownList;
	}

	/** Files with at least one visible line, sorted. */
	paths(): string[] {
		if (this.#stable) {
			const paths: string[] = [];
			for (const path of this.graph.knownFiles()) {
				if (this.hasFile(path)) paths.push(path);
				else this.#files.delete(path);
			}
			return paths.sort();
		}
		return this.#known.filter((p) => this.hasFile(p));
	}

	/** Every file the set has ever written a line in, including fully deleted ones. */
	knownPaths(): string[] {
		return [...this.#known];
	}

	/** The file line n sits in, in this set: fileOf by the line's number, with no lookup of its id. */
	fileOfNumber(n: number): string {
		return this.#fileOfN(n);
	}

	/** How many visible lines a file has. */
	visibleCount(path: string): number {
		return this.#file(path).vis.length;
	}

	/** Whether the file exists in this projection (has a visible line). */
	hasFile(path: string): boolean {
		const attrs = this.attrs(path);
		return attrs.exists || attrs.link !== null || attrs.blob !== null || this.#file(path).vis.length > 0;
	}

	/** A file's attributes: kept while empty, executable, a link's target. */
	attrs(path: string): FileAttrs {
		return this.#files.get(path)?.attrs ?? this.#attributes(path);
	}

	/** The projected text of a file ("" if it has no visible lines). */
	text(path: string): string {
		if (this.#textCache?.path === path) return this.#textCache.text;
		const { vis, visText } = this.#file(path);
		const lines: string[] = new Array(vis.length);
		for (let i = 0; i < vis.length; i++) lines[i] = visText?.[i] ?? this.graph.textOf(vis[i]!);
		const text = joinLines(lines);
		this.#textCache = { path, text };
		return text;
	}

	/** Whether a file reads the same here and in `other` (of the same graph), compared line by line without joining either (#46). */
	sameText(path: string, other: ReadView): boolean {
		if (!(other instanceof View)) {
			const a = this.lines(path),
				b = other.lines(path);
			return a.length === b.length && a.every((line, i) => line.text === b[i]!.text);
		}
		const a = this.#file(path).vis;
		const b = other.#file(path).vis;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++)
			if (a[i] !== b[i] && this.graph.textOf(a[i]!) !== this.graph.textOf(b[i]!)) return false;
		return true;
	}

	*lineChunks(path: string): IterableIterator<() => Iterable<string>> {
		for (const n of this.#file(path).vis) yield () => this.graph.textChunks(n);
	}

	/** Visible lines without retaining their text in the view cache. */
	*visibleLines(path: string): IterableIterator<VisibleLine> {
		const graph = this.graph;
		for (const n of this.#file(path).vis)
			yield { id: graph.lineIdOf(n), text: graph.textOf(n), atom: graph.idOfSeq(graph.writerSeqOf(n)) };
	}

	/** Atom-building line handles; text is loaded only when requested. */
	buildLines(path: string): readonly VisibleLine[] {
		const graph = this.graph;
		const vis = this.#file(path).vis;
		const lines: VisibleLine[] = new Array(vis.length);
		for (let i = 0; i < vis.length; i++) {
			const n = vis[i]!;
			lines[i] = {
				id: graph.lineIdOf(n),
				textChunks: () => graph.textChunks(n),
				get text() {
					return graph.textOf(n);
				},
				atom: graph.idOfSeq(graph.writerSeqOf(n)),
			};
		}
		return lines;
	}

	/** Visible lines with their ids. */
	lines(path: string): readonly VisibleLine[] {
		if (this.#linesCache?.path === path) return this.#linesCache.lines;
		const graph = this.graph;
		const vis = this.#file(path).vis;
		const lines: VisibleLine[] = new Array(vis.length);
		for (let i = 0; i < vis.length; i++) {
			const n = vis[i]!;
			lines[i] = { id: graph.lineIdOf(n), text: graph.textOf(n), atom: graph.idOfSeq(graph.writerSeqOf(n)) };
		}
		this.#linesCache = { path, lines };
		return lines;
	}

	/** The full linearized sequence of a file, tombstones included. */
	sequence(path: string): readonly SeqLine[] {
		if (this.#seqCache?.path === path) return this.#seqCache.seq;
		const graph = this.graph;
		const f = this.#file(path, true);
		const out: SeqLine[] = new Array(f.seq.length);
		for (let i = 0; i < f.seq.length; i++) {
			const n = f.seq[i]!;
			const by = f.deletedBy.get(i);
			out[i] = {
				id: graph.lineIdOf(n),
				text: graph.textOf(n),
				atom: graph.idOfSeq(graph.writerSeqOf(n)),
				deletedBy: by ? by.map((s) => graph.idOfSeq(s)) : NONE,
				visible: by === undefined,
			};
		}
		this.#seqCache = { path, seq: out };
		return out;
	}

	/** Two visible neighbours without retaining the file's historical sequence. */
	visibleNeighbours(path: string, line: LineId): LineId[] {
		const graph = this.graph;
		const target = graph.lineN(line);
		const start = graph.startCodeOf(path);
		if (target < 0 || start === undefined) return [];
		const scan = (nodes: Iterable<number>): LineId[] => {
			let previous: LineId | undefined;
			let found = false;
			for (const n of nodes) {
				if (n === target) {
					found = true;
					continue;
				}
				let deleted = false;
				for (const seq of graph.eachDeleterSeqOf(n))
					if (this.#has(seq)) {
						deleted = true;
						break;
					}
				if (deleted) continue;
				const id = graph.lineIdOf(n);
				if (found) return previous === undefined ? [id] : [previous, id];
				previous = id;
			}
			return found && previous !== undefined ? [previous] : [];
		};
		if (this.#scratchMoves())
			return graph.withProjectionScratch((scratch) =>
				scan(scratchLayoutNodes(graph, (id) => this.#has(graph.atom(id).seq), scratch, graph.nodeOf(start))),
			);
		return scan(this.#layoutNodes(start));
	}

	/** Index of a line in `sequence(path)`, or -1. */
	sequenceIndex(path: string, line: LineId): number {
		const f = this.#file(path, true);
		if (!f.seqIndex) {
			f.seqIndex = new Map();
			for (let i = 0; i < f.seq.length; i++) f.seqIndex.set(f.seq[i]!, i);
		}
		return f.seqIndex.get(this.graph.lineN(line)) ?? -1;
	}

	/** Index of a line in `lines(path)` (0-based visible line number), or -1 if not visible. */
	lineNumber(path: string, line: LineId): number {
		return this.lineNumberOf(path, this.graph.lineN(line));
	}

	/** lineNumber by the line's number, with no lookup of its id. */
	lineNumberOf(path: string, n: number): number {
		const f = this.#file(path);
		if (!f.visIndex) {
			f.visIndex = new Map();
			for (let i = 0; i < f.vis.length; i++) f.visIndex.set(f.vis[i]!, i);
		}
		return f.visIndex.get(n) ?? -1;
	}

	/** The seq of the atom that wrote each visible line, in order: lines() without ids or text. */
	visibleWriters(path: string): number[] {
		const graph = this.graph;
		return Array.from(this.#file(path).vis, (n) => graph.writerSeqOf(n));
	}

	/** All projected text files, path -> text, in path order. Binary files are in `blobs()`. */
	files(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const path of this.paths()) if (this.#file(path).attrs.blob === null) out[path] = this.text(path);
		return out;
	}

	/** Binary files, path -> the SHA-256 of their bytes, in path order. */
	blobs(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const path of this.paths()) {
			const blob = this.#file(path).attrs.blob;
			if (blob !== null) out[path] = blob;
		}
		return out;
	}

	/**
	 * About how many bytes of retained state this view costs (#46). This uses
	 * approximate ownership costs for containers and wrappers, not V8 heap
	 * measurements. Graph-owned strings and records count only as references.
	 * This method only inspects already-created state: it does not lay out files,
	 * populate lazy caches, enumerate the graph, or count temporary traversal
	 * containers and shared empty singleton payloads as retained view state.
	 */
	weight(): number {
		let n = this.#in.byteLength;
		n += 2 * ARRAY_HEADER_BYTES + this.#membershipSeq.byteLength + this.#membershipValue.byteLength;
		if (this.#movers) n += ARRAY_HEADER_BYTES + REFERENCE_BYTES * this.#movers.length;
		n += MAP_HEADER_BYTES; // #files exists from construction.
		if (this.#stable) n += this.#stable.retainedBytes;
		else if (this.#set) n += OBJECT_BYTES + SET_ENTRY_BYTES * this.#set.size;
		if (this.#knownList) n += ARRAY_HEADER_BYTES + REFERENCE_BYTES * this.#knownList.length;
		if (this.#relocs) n += MAP_HEADER_BYTES + MAP_ENTRY_BYTES * this.#relocs.size;
		if (this.#relocsN) n += MAP_HEADER_BYTES + (MAP_ENTRY_BYTES + OBJECT_BYTES) * this.#relocsN.size;
		for (const f of this.#files.values()) {
			n += MAP_ENTRY_BYTES;
			if (f !== NO_FILE) {
				// FileState and FileAttrs are per laid-out file; typed-array
				// headers are separate from their payload byte lengths below.
				n += OBJECT_BYTES + OBJECT_BYTES + 2 * ARRAY_HEADER_BYTES;
				n += f.seq.byteLength + f.vis.byteLength;
				if (f.visText) for (const text of f.visText) n += REFERENCE_BYTES + 2 * (text?.length ?? 0);
				n += MAP_HEADER_BYTES + (MAP_ENTRY_BYTES + ARRAY_HEADER_BYTES) * f.deletedBy.size;
				for (const deleters of f.deletedBy.values()) n += REFERENCE_BYTES * deleters.length;
				if (f.seqIndex) n += MAP_HEADER_BYTES + MAP_ENTRY_BYTES * f.seqIndex.size;
				if (f.visIndex) n += MAP_HEADER_BYTES + MAP_ENTRY_BYTES * f.visIndex.size;
			}
		}
		if (this.#linesCache)
			n += OBJECT_BYTES + REFERENCE_BYTES + ARRAY_HEADER_BYTES + 100 * this.#linesCache.lines.length;
		if (this.#seqCache) {
			n += OBJECT_BYTES + REFERENCE_BYTES + ARRAY_HEADER_BYTES + 120 * this.#seqCache.seq.length;
			for (const line of this.#seqCache.seq)
				if (line.deletedBy !== NONE) n += ARRAY_HEADER_BYTES + REFERENCE_BYTES * line.deletedBy.length;
		}
		if (this.#textCache) n += OBJECT_BYTES + REFERENCE_BYTES + ARRAY_HEADER_BYTES + 2 * this.#textCache.text.length;
		return n;
	}

	#file(path: string, complete = false): FileState {
		let state = this.#files.get(path);
		if (!state || (complete && !state.complete)) {
			state = this.graph.hasAtomsIn(path) ? this.#layout(path, complete) : NO_FILE;
			this.#files.set(path, state);
		}
		return state;
	}
}

/** The files of a closed set, path -> text. */
export function project(graph: Graph, set: Iterable<AtomId>): Record<string, string> {
	return new View(graph, set).files();
}

/** Where a node sits in a file's sequence: the index just after it (0 for a start node). */
export function indexAfter(view: Pick<ReadView, "sequenceIndex">, path: string, node: NodeId): number {
	if (isStartNode(node)) return 0;
	const i = view.sequenceIndex(path, node);
	if (i < 0) throw new EngineError("not-in-view", `line ${node} is not in ${path} in this view`);
	return i + 1;
}
