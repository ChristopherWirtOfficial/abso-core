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
import { isStartNode } from "./keys.ts";
import { StableSet } from "./state-source.ts";
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
const FILE_LOCATION_MEMO_ENTRIES = 256;

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
	/** Bounded memo: ancestry can span the entire history even for one visible line. */
	#fileOf = new Map<number, string>();
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
			for (const id of set) {
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
		const stronger = (a: RelocationInfo, b: RelocationInfo): boolean => graph.comparePriority(a.atom, b.atom) > 0;
		// Persistent reads decode new objects. Cycle suppression must identify the
		// logical move, not one particular decoded JavaScript object.
		const identity = (r: RelocationInfo): string => JSON.stringify([r.atom, r.k]);
		const ignored = new Set<string>();
		const pick = (line: LineId): RelocationInfo | undefined => {
			let best: RelocationInfo | undefined;
			for (const r of graph.relocationsOf(line)) {
				if (this.#has(graph.atom(r.atom).seq) && !ignored.has(identity(r)) && (!best || stronger(r, best))) best = r;
			}
			return best;
		};
		const relocs = new Map<LineId, RelocationInfo>();
		for (const id of this.#eachMover()) {
			for (const m of graph.atom(id).moves!) {
				if (!relocs.has(m.line)) relocs.set(m.line, pick(m.line)!);
			}
		}
		const parentOf = (line: LineId): NodeId => relocs.get(line)?.parent ?? graph.lineParent(line)!;
		const reaches = new Set<LineId>();
		for (const line of [...relocs.keys()]) {
			for (;;) {
				const path: LineId[] = [];
				const onPath = new Map<LineId, number>();
				let cur: NodeId = line;
				let loopAt = -1;
				while (!isStartNode(cur) && !reaches.has(cur)) {
					const at = onPath.get(cur);
					if (at !== undefined) {
						loopAt = at;
						break;
					}
					onPath.set(cur, path.length);
					path.push(cur);
					cur = parentOf(cur);
				}
				if (loopAt < 0) {
					for (const l of path) reaches.add(l);
					break;
				}
				let weakest: RelocationInfo | undefined;
				for (const l of path.slice(loopAt)) {
					const r = relocs.get(l);
					if (r && (!weakest || stronger(weakest, r))) weakest = r;
				}
				ignored.add(identity(weakest!));
				const next = pick(weakest!.line);
				if (next) relocs.set(weakest!.line, next);
				else relocs.delete(weakest!.line);
			}
		}
		this.#relocs = relocs;
		return relocs;
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
		const relocs = this.#relocationsN();
		// Keep only a fixed tail of the walk for path compression. The selected
		// relocation graph is acyclic, so traversal needs no history-sized stack.
		const path: number[] = [];
		let visited = 0;
		let cur = n;
		let file: string | undefined;
		while (file === undefined) {
			if (cur < 0) file = graph.nodeOf(cur).slice(1);
			else {
				file = this.#fileOf.get(cur);
				if (file === undefined) {
					path[visited++ % FILE_LOCATION_MEMO_ENTRIES] = cur;
					cur = relocs.get(cur)?.parent ?? graph.parentCodeOf(cur);
				}
			}
		}
		for (const l of path) {
			if (!this.#fileOf.has(l) && this.#fileOf.size >= FILE_LOCATION_MEMO_ENTRIES)
				this.#fileOf.delete(this.#fileOf.keys().next().value!);
			this.#fileOf.set(l, file);
		}
		return file;
	}

	/** The lines hanging off a node in this set, in layout order. */
	#children(code: number): Child[] {
		const graph = this.graph;
		const relocs = this.#hasMoves ? this.#relocationsN() : undefined;
		const ns: number[] = [];
		graph.childrenN(code, ns);
		const out: Child[] = [];
		for (const n of ns) {
			const seq = graph.writerSeqOf(n);
			if (!this.#has(seq) || relocs?.has(n)) continue;
			out.push({ n, replaces: graph.replacesN(n) ? 1 : 0, lamport: graph.lamportOfSeq(seq), seq, k: graph.kOf(n) });
		}
		if (relocs) {
			for (const r of graph.relocatedToCode(code)) {
				const n = graph.lineN(r.line);
				const selected = relocs.get(n)?.r;
				if (!selected || selected.atom !== r.atom || selected.k !== r.k) continue;
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

	/** Lay out one file: its line tree from the set's atoms, linearized. */
	#layout(path: string, complete: boolean): FileState {
		const graph = this.graph;
		// For each attribute, the highest-priority setter in the set wins.
		const setters = new Map<string, { id: AtomId; value: string | null }>();
		for (const id of graph.eachAtomIn(path)) {
			if (!this.#has(graph.atom(id).seq)) continue;
			for (const a of graph.atom(id).attrs ?? []) {
				if (a.file !== path) continue;
				const best = setters.get(a.name);
				if (!best || graph.comparePriority(best.id, id) < 0) setters.set(a.name, { id, value: a.value });
			}
		}

		const seq: number[] = [];
		const vis: number[] = [];
		const deletedBy = new Map<number, readonly number[]>();
		// Depth-first, iteratively (a file of n lines can be a chain n deep).
		const stack: number[] = [];
		const pushChildren = (code: number): void => {
			const list = this.#children(code);
			for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]!.n);
		};
		const start = graph.startCodeOf(path);
		if (start !== undefined) pushChildren(start);
		const priority = (a: number, b: number) => graph.lamportOfSeq(a) - graph.lamportOfSeq(b) || a - b;
		while (stack.length > 0) {
			const n = stack.pop()!;
			const deleters = graph.deleterSeqsOf(n);
			const by = deleters.length === 0 ? NONE : deleters.filter((d) => this.#has(d));
			if (by.length > 0) {
				if (complete) deletedBy.set(seq.length, by.length > 1 ? [...by].sort(priority) : by);
			} else vis.push(n);
			if (complete) seq.push(n);
			pushChildren(n);
		}
		const attrs: FileAttrs = {
			exists: setters.get("exists")?.value === "1",
			exec: setters.get("exec")?.value === "1",
			link: setters.get("link")?.value ?? null,
			blob: setters.get("blob")?.value ?? null,
		};
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

	/** Whether the file exists in this projection (has a visible line). */
	hasFile(path: string): boolean {
		const f = this.#file(path);
		return f.vis.length > 0 || f.attrs.exists || f.attrs.link !== null || f.attrs.blob !== null;
	}

	/** A file's attributes: kept while empty, executable, a link's target. */
	attrs(path: string): FileAttrs {
		return this.#file(path).attrs;
	}

	/** The projected text of a file ("" if it has no visible lines). */
	text(path: string): string {
		if (this.#textCache?.path === path) return this.#textCache.text;
		const vis = this.#file(path).vis;
		const lines: string[] = new Array(vis.length);
		for (let i = 0; i < vis.length; i++) lines[i] = this.graph.textOf(vis[i]!);
		const text = joinLines(lines);
		this.#textCache = { path, text };
		return text;
	}

	/** Whether a file reads the same here and in `other` (of the same graph), compared line by line without joining either (#46). */
	sameText(path: string, other: View): boolean {
		const a = this.#file(path).vis;
		const b = other.#file(path).vis;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++)
			if (a[i] !== b[i] && this.graph.textOf(a[i]!) !== this.graph.textOf(b[i]!)) return false;
		return true;
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
		const f = this.#file(path);
		if (!f.visIndex) {
			f.visIndex = new Map();
			for (let i = 0; i < f.vis.length; i++) f.visIndex.set(f.vis[i]!, i);
		}
		return f.visIndex.get(this.graph.lineN(line)) ?? -1;
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
		n += MAP_HEADER_BYTES; // #fileOf exists from construction.
		if (this.#stable) n += this.#stable.retainedBytes;
		else if (this.#set) n += OBJECT_BYTES + SET_ENTRY_BYTES * this.#set.size;
		if (this.#knownList) n += ARRAY_HEADER_BYTES + REFERENCE_BYTES * this.#knownList.length;
		if (this.#relocs) n += MAP_HEADER_BYTES + MAP_ENTRY_BYTES * this.#relocs.size;
		if (this.#relocsN) n += MAP_HEADER_BYTES + (MAP_ENTRY_BYTES + OBJECT_BYTES) * this.#relocsN.size;
		n += MAP_ENTRY_BYTES * this.#fileOf.size;
		for (const f of this.#files.values()) {
			n += MAP_ENTRY_BYTES;
			if (f !== NO_FILE) {
				// FileState and FileAttrs are per laid-out file; typed-array
				// headers are separate from their payload byte lengths below.
				n += OBJECT_BYTES + OBJECT_BYTES + 2 * ARRAY_HEADER_BYTES;
				n += f.seq.byteLength + f.vis.byteLength;
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
export function indexAfter(view: View, path: string, node: NodeId): number {
	if (isStartNode(node)) return 0;
	const i = view.sequenceIndex(path, node);
	if (i < 0) throw new EngineError("not-in-view", `line ${node} is not in ${path} in this view`);
	return i + 1;
}
