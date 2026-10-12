// The graph: every atom ever accepted, plus labels. Sets of atoms (states of
// the codebase) are separate values; the graph only answers questions about
// atoms and keeps indexes so those questions are cheap.

import {
	atomId,
	attrKey,
	gapKey,
	isAtomId,
	isStartNode,
	lineId,
	lineKey,
	parseKey,
	posKey,
	seqOf,
	startNode,
} from "./keys.ts";
import { OrderedIndex, orderedChildKey } from "./ordered-index.ts";
import {
	type GraphStateStorage,
	type StateMap,
	storedArray,
	storedLists,
	storedMap,
	storedNumbers,
} from "./state-source.ts";
import {
	ATTR_NAMES,
	type Atom,
	type AtomId,
	EngineError,
	type InsertRun,
	type Key,
	type Label,
	type LineId,
	type NodeId,
	REASON_KINDS,
	type Reason,
} from "./types.ts";

/**
 * Where a line was written and what it says. Its text never changes. A move
 * can give it another parent in a set, even in another file: `view.parentOf`
 * and `view.fileOf` say where it is in a set.
 */
export interface LineInfo {
	readonly id: LineId;
	readonly atom: AtomId;
	readonly k: number;
	/** The file it was written in. */
	readonly file: string;
	/** The node it was written after. */
	readonly parent: NodeId;
	readonly text: string;
}

/** One relocation of a line, by the atom that made it; `k` is its place in that atom's moves. */
export interface RelocationInfo {
	readonly atom: AtomId;
	readonly line: LineId;
	readonly parent: NodeId;
	readonly k: number;
}

/** A `together` reason seen from one end: `other` is the atom at the far end. */
export interface TogetherLink {
	readonly other: AtomId;
	readonly text: string;
	/** The atom that carries the reason. */
	readonly from: AtomId;
}

export const GRAPH_FORMAT = "ai-first-vcs.graph";

/** The saved form of a graph. Atoms are in seq order. */
export interface GraphJSON {
	readonly format: typeof GRAPH_FORMAT;
	readonly version: 1;
	readonly atoms: readonly Atom[];
	readonly labels: readonly Label[];
}

/**
 * An index entry that holds a lone value as itself, and a list only once there
 * are two (#46): most keys name one atom, and a list for each costs more than
 * the value.
 */
function pushOne<K, V>(map: StateMap<K, V | V[]>, key: K, value: V): void {
	const had = map.get(key);
	if (had === undefined) map.set(key, value);
	else if (Array.isArray(had)) {
		had.push(value);
		map.set(key, had);
	} else map.set(key, [had, value]);
}

function listOf<V>(had: V | V[] | undefined): readonly V[] {
	return had === undefined ? EMPTY : Array.isArray(had) ? had : [had];
}

function pushIndex<K, V>(map: StateMap<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) {
		list.push(value);
		map.set(key, list);
	} else map.set(key, [value]);
}

const EMPTY: readonly never[] = Object.freeze([]);

/**
 * A run whose lines are read when asked for (#46, text on disk): a few fields
 * and a shared reader, where an object with its own accessor cost about 400
 * bytes a run.
 */
class LazyRun implements InsertRun {
	readonly file: string;
	readonly parent: NodeId;
	readonly #text: (start: number, length: number) => readonly string[];
	readonly #start: number;
	readonly #length: number;
	constructor(
		file: string,
		parent: NodeId,
		text: (start: number, length: number) => readonly string[],
		start: number,
		length: number,
	) {
		this.file = file;
		this.parent = parent;
		this.#text = text;
		this.#start = start;
		this.#length = length;
	}
	get lines(): readonly string[] {
		return this.#text(this.#start, this.#length);
	}
	toJSON(): InsertRun {
		return { file: this.file, parent: this.parent, lines: this.lines };
	}
}

/** Characters of atoms' text a graph that keeps text elsewhere holds at most (#46): about 8 MB. */
const TEXT_CACHE = 4_000_000;
/** How many list items (deletes and keys) are kept read back (#46): publishes and syncs meet few atoms, but one reformat's atom can hold 100,000. */
const LIST_CACHE = 50_000;

/** An atom's deletes and claim keys: kept in the log rather than in memory when the graph has a `lists` reader (#46). */
export interface AtomLists {
	readonly deletes: readonly LineId[];
	readonly writes: readonly Key[];
	readonly reads: readonly Key[];
	readonly holds: readonly Key[];
}

function listItems(l: AtomLists): number {
	return l.deletes.length + l.writes.length + l.reads.length + l.holds.length;
}

function frozenList<T>(xs: readonly T[]): readonly T[] {
	return xs.length === 0 ? (EMPTY as readonly T[]) : Object.freeze([...xs]);
}

/**
 * An atom whose deletes, writes, reads and holds are read back through `read` (#46). The getters live on the
 * prototype, so each atom keeps one reader and a fixed shape, not four closures in a dictionary-mode object.
 */
class ListedAtom {
	readonly #read: () => AtomLists;
	constructor(fields: object, read: () => AtomLists) {
		Object.assign(this, fields);
		this.#read = read;
	}
	get deletes(): readonly LineId[] {
		return this.#read().deletes;
	}
	get writes(): readonly Key[] {
		return this.#read().writes;
	}
	get reads(): readonly Key[] {
		return this.#read().reads;
	}
	get holds(): readonly Key[] {
		return this.#read().holds;
	}
	toJSON(): object {
		return { ...this, ...this.#read() };
	}
}

/** A growable array of 32-bit integers: a line's fields cost 4 bytes each, not an object and its strings (#46). */
interface NumberIndex {
	readonly length: number;
	push(n: number): void;
	at(i: number): number;
	set(i: number, n: number): void;
}

class Ints implements NumberIndex {
	#buf: Int32Array | Uint8Array;
	/** bytes: values 0-255 only, one byte each. */
	constructor(bytes = false) {
		this.#buf = bytes ? new Uint8Array(1024) : new Int32Array(1024);
	}
	length = 0;
	push(n: number): void {
		if (this.length === this.#buf.length) {
			const bigger =
				this.#buf instanceof Uint8Array ? new Uint8Array(this.#buf.length * 2) : new Int32Array(this.#buf.length * 2);
			bigger.set(this.#buf);
			this.#buf = bigger;
		}
		this.#buf[this.length++] = n;
	}
	at(i: number): number {
		return this.#buf[i]!;
	}
	set(i: number, n: number): void {
		this.#buf[i] = n;
	}
}

/**
 * A line id's place in the graph's line arrays, or -1: "a<seq>.<k>" is line
 * `base[seq] + k`. Hand-parsed, as seqOf is, with the same rules: no leading
 * zeros, and k within the lines its atom wrote.
 */
function parseLineId(id: string): { seq: number; k: number } | undefined {
	if (typeof id !== "string") return undefined;
	const n = id.length;
	if (n < 4 || id.charCodeAt(0) !== 97 /* a */) return undefined;
	let i = 1;
	let seq = 0;
	const seqStart = i;
	for (; i < n; i++) {
		const c = id.charCodeAt(i);
		if (c === 46 /* . */) break;
		if (c < 48 || c > 57) return undefined;
		seq = seq * 10 + (c - 48);
	}
	if (i === seqStart || i >= n - 1 || i - seqStart > 15 || (i - seqStart > 1 && id.charCodeAt(seqStart) === 48))
		return undefined;
	const kStart = ++i;
	let k = 0;
	for (; i < n; i++) {
		const c = id.charCodeAt(i);
		if (c < 48 || c > 57) return undefined;
		k = k * 10 + (c - 48);
	}
	if (i - kStart > 15 || (i - kStart > 1 && id.charCodeAt(kStart) === 48)) return undefined;
	return { seq, k };
}

export class Graph {
	readonly #storage?: GraphStateStorage;
	#atoms: Atom[] = [];
	#lamport: number[] = [];
	// Lines, packed (#46): line n is the k-th line atom seq wrote, n = #lineBase[seq] + k. Each holds its
	// atom's seq, the file it was written in (an index into #paths) and its parent (a line's n, or -1 - a
	// path's index for a file's start). Its text stays in the atom. Ids and LineInfo objects are made only
	// when asked for, so a line costs about 16 bytes here instead of a record, its id and its parent's id.
	#lineBase: number[] = [];
	#lineAtom: NumberIndex = new Ints();
	#lineFile: NumberIndex = new Ints();
	#lineParent: NumberIndex = new Ints();
	/** Lines' text, when the graph keeps it; without it, it comes from `texts` (#46, text on disk). */
	#lineText: string[] | undefined = [];
	get #lineTotal(): number {
		return this.#lineAtom.length;
	}
	/** Where an atom's lines' text is when the graph doesn't keep it: each run's lines, by the atom's seq. */
	#texts: ((seq: number) => readonly (readonly string[])[]) | undefined;
	/** Recently read atoms' text, flattened, most recent last, up to TEXT_CACHE characters. */
	#textCache = new Map<number, readonly string[]>();
	#textCached = 0;

	/**
	 * `texts`, when given, says where each atom's lines' text can be read back
	 * (#46): the graph then keeps no text, only each line's place, and reads an
	 * atom's text when a line of it is asked for, keeping the most recent.
	 */
	constructor(
		options: {
			texts?: (seq: number) => readonly (readonly string[])[];
			lists?: (seq: number) => AtomLists;
			storage?: GraphStateStorage;
		} = {},
	) {
		if (options.texts) {
			this.#texts = options.texts;
			this.#lineText = undefined;
		}
		if (options.lists) this.#lists = options.lists;
		this.#storage = options.storage;
		if (options.storage) {
			const storage = options.storage;
			const numbers = (name: string): NumberIndex => storedNumbers(storage, name);
			this.#atoms = storedArray<Atom>(storage, "atoms", (atom) =>
				freezeAtom(
					atom,
					(id) => id,
					(author) => author,
				),
			);
			this.#lamport = storedArray(storage, "lamport");
			this.#lineBase = storedArray(storage, "line-base");
			this.#paths = storedArray(storage, "paths");
			this.#movers = storedArray(storage, "movers");
			this.#atomFiles = storedArray(storage, "atom-files");
			this.#atomDeletes = storedArray(storage, "atom-deletes");
			this.#lineAtom = numbers("line-atom");
			this.#lineFile = numbers("line-file");
			this.#lineParent = numbers("line-parent");
			this.#deleter = numbers("deleter");
			this.#replacing = numbers("replacing");
			this.#lineText = storedArray(storage, "line-text");
			this.#pathIndex = storedMap(storage, "path-index");
			this.#moreDeleterPages = storedLists<number>(storage, "more-deleters", (key) =>
				JSON.stringify(["number", Number(key)]),
			);
			this.#writersPages = storedLists<AtomId>(storage, "writers", (key) => key);
			this.#readersPages = storedLists<AtomId>(storage, "readers", (key) => key);
			this.#holdersPages = storedLists<AtomId>(storage, "holders", (key) => key);
			this.#dependentsPages = storedLists<AtomId>(storage, "dependents");
			this.#resolversPages = storedLists<AtomId>(storage, "resolvers");
			this.#togetherPages = storedLists<TogetherLink>(storage, "together");
			this.#fileAtomPages = storedLists<AtomId>(storage, "file-atoms");
			this.#runStartPages = storedLists<number>(storage, "run-starts", (key) =>
				JSON.stringify(["number", Number(key)]),
			);
			this.#relocationPages = storedLists<RelocationInfo>(storage, "relocations");
			this.#relocatedToPages = storedLists<RelocationInfo>(storage, "relocated-to");
			this.#relocatedToCodePages = storedLists<RelocationInfo>(storage, "relocated-to-code", (key) =>
				JSON.stringify(["number", Number(key)]),
			);
			this.#labels = storedMap(storage, "labels");
		}
	}

	/** Where an atom's key and delete lists are when the graph doesn't keep them (#46): the stored atom. */
	#lists: ((seq: number) => AtomLists) | undefined;
	/** Recently read atoms' lists, most recent last, up to LIST_CACHE atoms. */
	#listCache = new Map<number, AtomLists>();
	#listCached = 0;

	/** An atom's deletes, writes, reads and holds, read back from where they are stored. */
	#listsOf(seq: number): AtomLists {
		const hit = this.#listCache.get(seq);
		if (hit) {
			this.#listCache.delete(seq);
			this.#listCache.set(seq, hit);
			return hit;
		}
		const got = this.#lists!(seq);
		const lists: AtomLists = {
			deletes: frozenList(got.deletes),
			writes: frozenList(got.writes),
			reads: frozenList(got.reads),
			holds: frozenList(got.holds),
		};
		this.#listCache.set(seq, lists);
		this.#listCached += listItems(lists);
		for (const [old, kept] of this.#listCache) {
			if (this.#listCached <= LIST_CACHE || old === seq) break;
			this.#listCache.delete(old);
			this.#listCached -= listItems(kept);
		}
		return lists;
	}

	/** The reader an atom's lists use; made apart from add() so it keeps no atom alive (see #reader). */
	#listReader(seq: number): () => AtomLists {
		return () => this.#listsOf(seq);
	}

	/**
	 * A claim key as the index keeps it (#46): a line's L:, P: and G: keys by its n (n * 4, + 1, + 2), so the
	 * index holds numbers rather than one string per line; start-node and attribute keys stay strings. A key
	 * naming a line the graph doesn't have stays a string, which nothing has claimed.
	 */
	#code(key: Key): Key | number {
		const t = key.charCodeAt(0);
		if (key.charCodeAt(1) !== 58 || key.charCodeAt(2) === 94) return key; // not "X:", or a start node "^"
		const k = t === 76 ? 0 : t === 80 ? 1 : t === 71 ? 2 : -1; // L, P, G
		if (k < 0) return key;
		const n = this.#lineN(key.slice(2));
		return n < 0 ? key : n * 4 + k;
	}

	/** An atom's lines' text, in k order. */
	#textOf(seq: number): readonly string[] {
		const hit = this.#textCache.get(seq);
		if (hit) {
			this.#textCache.delete(seq);
			this.#textCache.set(seq, hit);
			return hit;
		}
		const flat = this.#texts!(seq).flat();
		let chars = 0;
		for (const t of flat) chars += t.length + 1;
		this.#textCache.set(seq, flat);
		this.#textCached += chars;
		for (const [old, lines] of this.#textCache) {
			if (this.#textCached <= TEXT_CACHE || old === seq) break;
			this.#textCache.delete(old);
			for (const t of lines) this.#textCached -= t.length + 1;
		}
		return flat;
	}

	/**
	 * The reader an atom's runs use. Made in a function of its own: a closure made inside add() would
	 * keep add()'s whole scope alive, the atom as given with all its text included.
	 */
	#reader(seq: number): (start: number, length: number) => readonly string[] {
		return (start, length) => this.#textOf(seq).slice(start, start + length);
	}

	/** Line n's text. */
	#text(n: number): string {
		if (this.#lineText) return this.#lineText[n]!;
		const seq = this.#lineAtom.at(n);
		return this.#textOf(seq)[n - this.#lineBase[seq]!]!;
	}
	#paths: string[] = [];
	#pathIndex: StateMap<string, number> = new Map();
	/** The first atom that deletes each line (its seq), or -1; a line deleted by more than one has the rest in #moreDeleters. */
	#deleter: NumberIndex = new Ints();
	#moreDeleters: StateMap<number, number[]> = new Map();
	#moreDeleterPages: ReturnType<typeof storedLists<number>> | undefined;
	#writers: StateMap<Key | number, AtomId | AtomId[]> = new Map();
	#writersPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	#readers: StateMap<Key | number, AtomId | AtomId[]> = new Map();
	#readersPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	#holders: StateMap<Key | number, AtomId | AtomId[]> = new Map();
	#holdersPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	#dependents: StateMap<AtomId, AtomId | AtomId[]> = new Map();
	#dependentsPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	#resolvers: StateMap<AtomId, AtomId | AtomId[]> = new Map();
	#resolversPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	#together: StateMap<AtomId, TogetherLink[]> = new Map();
	#togetherPages: ReturnType<typeof storedLists<TogetherLink>> | undefined;
	#fileAtoms: StateMap<string, AtomId[]> = new Map();
	#fileAtomPages: ReturnType<typeof storedLists<AtomId>> | undefined;
	/** First lines of runs (their n), by the node they were written after: a line's n, or -1 - a path's index. */
	#runStarts: StateMap<number, number | number[]> = new Map();
	#runStartPages: ReturnType<typeof storedLists<number>> | undefined;
	/** 1 for the first line of a run whose atom deleted the line it hangs off: the run replaces it. */
	#replacing: NumberIndex = new Ints(true);
	#relocations: StateMap<LineId, RelocationInfo[]> = new Map();
	#relocationPages: ReturnType<typeof storedLists<RelocationInfo>> | undefined;
	#relocatedTo: StateMap<NodeId, RelocationInfo[]> = new Map();
	#relocatedToPages: ReturnType<typeof storedLists<RelocationInfo>> | undefined;
	/** The same relocations by node code (a line's n, or -1 - a path's index), for views laid out by number. */
	#relocatedToCode: StateMap<number, RelocationInfo[]> = new Map();
	#relocatedToCodePages: ReturnType<typeof storedLists<RelocationInfo>> | undefined;
	#movers: AtomId[] = [];
	#atomFiles: (readonly string[])[] = [];
	/** Each atom's deleted lines by n, packed (#46), or undefined when it deletes none. */
	#atomDeletes: (readonly number[] | Int32Array | undefined)[] = [];
	#labels: StateMap<string, Label> = new Map();
	/** Each author's name kept once (#46). */
	#authors = new Map<string, string>();

	/** Number of atoms (also the seq the next atom gets). */
	get size(): number {
		return this.#atoms.length;
	}

	/** The id the next accepted atom must have. */
	nextId(): AtomId {
		return atomId(this.#atoms.length);
	}

	has(id: AtomId): boolean {
		const seq = this.#seq(id);
		return seq >= 0 && seq < this.#atoms.length;
	}

	atom(id: AtomId): Atom {
		const seq = this.#seq(id);
		const atom = seq >= 0 ? this.#atoms[seq] : undefined;
		if (!atom) throw new EngineError("unknown-atom", `no atom ${id}`);
		return atom;
	}

	/** All atoms in seq order. */
	atoms(): readonly Atom[] {
		return this.#atoms;
	}

	/** lamport(a) = 1 + max lamport of its deps; 0 for an atom with no deps (such as a0). */
	lamport(id: AtomId): number {
		this.atom(id);
		return this.#lamport[this.#seq(id)]!;
	}

	/** Compare by priority (lamport, then seq). Negative when a comes first (is lower). */
	comparePriority(a: AtomId, b: AtomId): number {
		return this.lamport(a) - this.lamport(b) || this.#seq(a) - this.#seq(b);
	}

	line(id: LineId): LineInfo | undefined {
		const n = this.#lineN(id);
		if (n < 0) return undefined;
		const seq = this.#lineAtom.at(n);
		return {
			id,
			atom: this.#atoms[seq]!.id,
			k: n - this.#lineBase[seq]!,
			file: this.#paths[this.#lineFile.at(n)]!,
			parent: this.#nodeName(this.#lineParent.at(n)),
			text: this.#text(n),
		};
	}

	/** A line's text, or undefined for an unknown line: line(id).text without making the record. */
	lineText(id: LineId): string | undefined {
		const n = this.#lineN(id);
		return n < 0 ? undefined : this.#text(n);
	}

	/** The atom that wrote a line, or undefined: line(id).atom without making the record. */
	lineAtom(id: LineId): AtomId | undefined {
		const n = this.#lineN(id);
		return n < 0 ? undefined : this.#atoms[this.#lineAtom.at(n)]!.id;
	}

	/** The file a line was written in, or undefined: line(id).file without making the record. */
	lineFile(id: LineId): string | undefined {
		const n = this.#lineN(id);
		return n < 0 ? undefined : this.#paths[this.#lineFile.at(n)];
	}

	/** The node a line was written after, or undefined: line(id).parent without making the record. */
	lineParent(id: LineId): NodeId | undefined {
		const n = this.#lineN(id);
		return n < 0 ? undefined : this.#nodeName(this.#lineParent.at(n));
	}

	// By number, for views (#46) ------------------------------------------------------
	// A line's n and a node's code (a line's n, or -1 - a path's index for a file's start) as the graph
	// keeps them, so a view can lay files out as arrays of numbers. For the engine's own use.

	/** A line id's n, or -1 for an unknown line. */
	lineN(id: LineId): number {
		return this.#lineN(id);
	}

	/** A line's id from its n. */
	lineIdOf(n: number): LineId {
		return this.#lineName(n);
	}

	/** The lines an atom deletes, from the graph's own packed copy (#46): never a read of the log. */
	deletedLines(id: AtomId): readonly LineId[] {
		const ns = this.#atomDeletes[this.#seq(id)];
		if (!ns) return EMPTY;
		const out: LineId[] = new Array(ns.length);
		for (let i = 0; i < ns.length; i++) out[i] = this.#lineName(ns[i]!);
		return out;
	}

	/** How many lines an atom deletes, without reading its lists. */
	deleteCount(id: AtomId): number {
		return this.#atomDeletes[this.#seq(id)]?.length ?? 0;
	}

	textOf(n: number): string {
		return this.#text(n);
	}

	/** The seq of the atom that wrote line n. */
	writerSeqOf(n: number): number {
		return this.#lineAtom.at(n);
	}

	/** Line n's k: its place among its atom's lines. */
	kOf(n: number): number {
		return n - this.#lineBase[this.#lineAtom.at(n)]!;
	}

	/** The atom id with this seq, as the graph keeps it. */
	idOfSeq(seq: number): AtomId {
		return this.#atoms[seq]!.id;
	}

	lamportOfSeq(seq: number): number {
		return this.#lamport[seq]!;
	}

	/** The file line n was written in. */
	writtenIn(n: number): string {
		return this.#paths[this.#lineFile.at(n)]!;
	}

	/** The code of the node line n was written after. */
	parentCodeOf(n: number): number {
		return this.#lineParent.at(n);
	}

	/** A node's code, or undefined for a node the graph doesn't know (a start node of a file nothing was written in). */
	codeOf(node: NodeId): number | undefined {
		return this.#nodeCode(node);
	}

	/** The node a code names. */
	nodeOf(code: number): NodeId {
		return this.#nodeName(code);
	}

	/** The start node's code for a path, or undefined when nothing was ever written in it. */
	startCodeOf(path: string): number | undefined {
		const p = this.#pathIndex.get(path);
		return p === undefined ? undefined : -1 - p;
	}

	/** The lines (their n) written right after a node, as childrenOf, into `out`. */

	childrenN(code: number, out: number[]): void {
		for (const n of this.eachChildN(code)) out.push(n);
	}
	*eachChildN(code: number): IterableIterator<number> {
		if (
			code >= 0 &&
			code + 1 < this.#lineTotal &&
			this.#lineAtom.at(code + 1) === this.#lineAtom.at(code) &&
			this.#lineParent.at(code + 1) === code
		)
			yield code + 1;
		if (this.#runStartPages) yield* this.#runStartPages.values(String(code));
		else yield* listOf(this.#runStarts.get(code));
	}

	get hasOrderedChildren(): boolean {
		return this.#storage !== undefined;
	}
	#childPriority(n: number): string {
		const seq = this.writerSeqOf(n);
		return orderedChildKey({
			n,
			replaces: this.replacesN(n) ? 1 : 0,
			lamport: this.lamportOfSeq(seq),
			seq,
			k: this.kOf(n),
		});
	}
	/** Persistent layout order with a strict successor cursor; moves are separate. */
	*orderedChildrenN(code: number, after?: number): IterableIterator<number> {
		if (!this.#storage) throw new Error("ordered children require indexed storage");
		const index = new OrderedIndex(this.#storage, "ordered-children", String(code));
		if (this.#storage.read("ordered-children", "format") !== 1)
			throw new Error("ordered children require fresh adoption");
		if (index.size !== this.#runStartPages!.length(String(code))) throw new Error("ordered child index count mismatch");
		const cursor = after === undefined ? undefined : this.#childPriority(after);
		let implicit: number | undefined;
		if (
			code >= 0 &&
			code + 1 < this.#lineTotal &&
			this.#lineAtom.at(code + 1) === this.#lineAtom.at(code) &&
			this.#lineParent.at(code + 1) === code
		)
			implicit = code + 1;
		if (implicit !== undefined && cursor !== undefined && this.#childPriority(implicit) <= cursor) implicit = undefined;
		for (const n of index.values(cursor)) {
			if (implicit !== undefined && this.#childPriority(implicit) < this.#childPriority(n)) {
				yield implicit;
				implicit = undefined;
			}
			yield n;
		}
		if (implicit !== undefined) yield implicit;
	}

	replacesN(n: number): boolean {
		return this.#replacing.at(n) === 1;
	}

	/** The seqs of every atom that deletes line n (none: an empty list, shared). */
	deleterSeqsOf(n: number): readonly number[] {
		return [...this.eachDeleterSeqOf(n)];
	}
	*eachDeleterSeqOf(n: number): IterableIterator<number> {
		const first = this.#deleter.at(n);
		if (first < 0) return;
		yield first;
		if (this.#moreDeleterPages) yield* this.#moreDeleterPages.values(String(n));
		else yield* this.#moreDeleters.get(n) ?? EMPTY;
	}

	/** Every relocation that puts a line right after the node with this code. */
	relocatedToCode(code: number): readonly RelocationInfo[] {
		if (this.#relocatedToCodePages) return [...this.eachRelocatedToCode(code)];
		return this.#relocatedToCode.get(code) ?? EMPTY;
	}
	*eachRelocatedToCode(code: number): IterableIterator<RelocationInfo> {
		if (this.#relocatedToCodePages) yield* this.#relocatedToCodePages.values(String(code));
		else yield* this.#relocatedToCode.get(code) ?? EMPTY;
	}

	/** How many lines every atom together has written. */
	get lineCount(): number {
		return this.#lineTotal;
	}

	/** A line id's n, or -1 when no accepted atom wrote it. */
	#lineN(id: LineId): number {
		const p = parseLineId(id);
		if (!p || p.seq >= this.#atoms.length) return -1;
		const base = this.#lineBase[p.seq]!;
		const end = p.seq + 1 < this.#lineBase.length ? this.#lineBase[p.seq + 1]! : this.#lineTotal;
		return p.k < end - base ? base + p.k : -1;
	}

	/** A line's id from its n. */
	#lineName(n: number): LineId {
		const seq = this.#lineAtom.at(n);
		return `${this.#atoms[seq]!.id}.${n - this.#lineBase[seq]!}`;
	}

	/** A node's code: a line's n, or -1 - a path's index for a start node; undefined when unknown. */
	#nodeCode(node: NodeId): number | undefined {
		if (isStartNode(node)) {
			const p = this.#pathIndex.get(node.slice(1));
			return p === undefined ? undefined : -1 - p;
		}
		const n = this.#lineN(node);
		return n < 0 ? undefined : n;
	}

	#nodeName(code: number): NodeId {
		return code >= 0 ? this.#lineName(code) : startNode(this.#paths[-1 - code]!);
	}

	#pathOf(file: string): number {
		let p = this.#pathIndex.get(file);
		if (p === undefined) {
			p = this.#paths.push(file) - 1;
			this.#pathIndex.set(file, p);
		}
		return p;
	}

	/** The line ids an atom inserted, in k order. */
	linesOf(id: AtomId): LineId[] {
		const atom = this.atom(id);
		const out: LineId[] = [];
		const seq = atom.seq;
		const count = (seq + 1 < this.#lineBase.length ? this.#lineBase[seq + 1]! : this.#lineTotal) - this.#lineBase[seq]!;
		for (let k = 0; k < count; k++) out.push(lineId(id, k));
		return out;
	}

	/** Every atom that deletes this line (across the whole graph). */
	deletersOf(line: LineId): readonly AtomId[] {
		const n = this.#lineN(line);
		if (n < 0) return EMPTY;
		return [...this.eachDeleterSeqOf(n)].map((seq) => this.#atoms[seq]!.id);
	}

	writersOf(key: Key): readonly AtomId[] {
		return [...this.eachWriterOf(key)];
	}
	*eachWriterOf(key: Key): IterableIterator<AtomId> {
		const code = this.#code(key);
		if (this.#writersPages) yield* this.#writersPages.values(JSON.stringify([typeof code, code]));
		else yield* listOf(this.#writers.get(code));
	}

	/** Atoms whose implicit reads include the key. */
	readersOf(key: Key): readonly AtomId[] {
		return [...this.eachReaderOf(key)];
	}
	*eachReaderOf(key: Key): IterableIterator<AtomId> {
		const code = this.#code(key);
		if (this.#readersPages) yield* this.#readersPages.values(JSON.stringify([typeof code, code]));
		else yield* listOf(this.#readers.get(code));
	}

	/** Atoms whose explicit holds include the key. */
	holdersOf(key: Key): readonly AtomId[] {
		return [...this.eachHolderOf(key)];
	}
	*eachHolderOf(key: Key): IterableIterator<AtomId> {
		const code = this.#code(key);
		if (this.#holdersPages) yield* this.#holdersPages.values(JSON.stringify([typeof code, code]));
		else yield* listOf(this.#holders.get(code));
	}

	/** Every atom that inserts or deletes a line of the file, in seq order. */
	atomsIn(file: string): readonly AtomId[] {
		if (this.#fileAtomPages) return [...this.#fileAtomPages.values(file)];
		return this.#fileAtoms.get(file) ?? EMPTY;
	}
	*eachAtomIn(file: string): IterableIterator<AtomId> {
		if (this.#fileAtomPages) yield* this.#fileAtomPages.values(file);
		else yield* this.#fileAtoms.get(file) ?? EMPTY;
	}
	hasAtomsIn(file: string): boolean {
		return this.#fileAtomPages ? this.#fileAtomPages.length(file) > 0 : this.#fileAtoms.has(file);
	}

	/** Unique historical file paths, streamed without collecting their names. */
	*knownFiles(): IterableIterator<string> {
		yield* this.#fileAtomPages ? this.#fileAtomPages.keys() : this.#fileAtoms.keys();
	}

	/**
	 * The files an atom inserts, deletes or moves lines in, or sets attributes
	 * of, sorted. For lines, the file each was written in (or, for a move to a
	 * start node, that file): a set's moves can have taken them elsewhere.
	 */
	filesOf(id: AtomId): readonly string[] {
		this.atom(id);
		return this.#atomFiles[this.#seq(id)]!;
	}

	/** Lines written right after a node (not counting moves), in seq order. */

	childrenOf(node: NodeId): LineId[] {
		const code = this.#nodeCode(node);
		return code === undefined ? [] : [...this.eachChildN(code)].map((n) => this.#lineName(n));
	}

	/** Whether a line starts a run whose atom deleted the line it hangs off. */
	replaces(line: LineId): boolean {
		const n = this.#lineN(line);
		return n >= 0 && this.#replacing.at(n) === 1;
	}

	/** Every relocation of a line, in seq order. */
	relocationsOf(line: LineId): readonly RelocationInfo[] {
		if (this.#relocationPages) return [...this.eachRelocationOf(line)];
		return this.#relocations.get(line) ?? EMPTY;
	}
	*eachRelocationOf(line: LineId): IterableIterator<RelocationInfo> {
		if (this.#relocationPages) yield* this.#relocationPages.values(line);
		else yield* this.#relocations.get(line) ?? EMPTY;
	}

	/** Every relocation that puts a line right after this node, in seq order. */
	relocatedTo(node: NodeId): readonly RelocationInfo[] {
		if (this.#relocatedToPages) return [...this.#relocatedToPages.values(node)];
		return this.#relocatedTo.get(node) ?? EMPTY;
	}

	/** Atoms that move lines, in seq order. */
	movers(): readonly AtomId[] {
		return this.#movers;
	}

	/** Atoms that list this one directly in their deps. */
	dependentsOf(id: AtomId): readonly AtomId[] {
		return [...this.eachDependentOf(id)];
	}
	*eachDependentOf(id: AtomId): IterableIterator<AtomId> {
		if (this.#dependentsPages) yield* this.#dependentsPages.values(id);
		else yield* listOf(this.#dependents.get(id));
	}

	/** Atoms whose `resolves` names this one. */
	resolversOf(id: AtomId): readonly AtomId[] {
		return [...this.eachResolverOf(id)];
	}
	*eachResolverOf(id: AtomId): IterableIterator<AtomId> {
		if (this.#resolversPages) yield* this.#resolversPages.values(id);
		else yield* listOf(this.#resolvers.get(id));
	}

	/** `together` reasons touching this atom, in either direction. */
	togetherLinks(id: AtomId): readonly TogetherLink[] {
		return [...this.eachTogetherLink(id)];
	}
	*eachTogetherLink(id: AtomId): IterableIterator<TogetherLink> {
		if (this.#togetherPages) yield* this.#togetherPages.values(id);
		else yield* this.#together.get(id) ?? EMPTY;
	}

	/**
	 * The atom plus everything it depends on, transitively. Computed on demand
	 * and not cached: a cached set per atom costs memory quadratic in the length
	 * of a dependency chain. Use `dependsOn` to ask about one pair.
	 */
	closure(id: AtomId): Set<AtomId> {
		return this.closureOf([id]);
	}

	/** The atoms plus everything they depend on, transitively. */
	closureOf(ids: Iterable<AtomId>): Set<AtomId> {
		const out = new Set<AtomId>();
		const stack: AtomId[] = [];
		for (const id of ids) {
			this.atom(id);
			if (!out.has(id)) {
				out.add(id);
				stack.push(id);
			}
		}
		while (stack.length > 0) {
			for (const d of this.atom(stack.pop()!).deps) {
				if (!out.has(d)) {
					out.add(d);
					stack.push(d);
				}
			}
		}
		return out;
	}

	/** Whether `b` is in the closure of `a` (an atom is in its own closure). */
	dependsOn(a: AtomId, b: AtomId): boolean {
		const atom = this.atom(a);
		this.atom(b);
		return a === b || this.#reaches(atom.deps, b);
	}

	/**
	 * Whether `target` is reachable along deps from any of `from` (themselves
	 * included). A dependency always has a lower lamport than its dependent, so
	 * the search never descends below the target's lamport.
	 */
	#reaches(from: Iterable<AtomId>, target: AtomId): boolean {
		const floor = this.#lamport[this.#seq(target)]!;
		const seen = new Set<AtomId>();
		const stack = [...from];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (cur === target) return true;
			if (seen.has(cur)) continue;
			seen.add(cur);
			if (this.#lamport[this.#seq(cur)]! <= floor) continue;
			for (const d of this.atom(cur).deps) if (!seen.has(d)) stack.push(d);
		}
		return false;
	}

	/**
	 * Accept an atom into the graph. It must carry the next id and seq, and
	 * everything it touches must come from atoms in its dependency closure.
	 * The atom is frozen. Adding to the graph does not add it to any set.
	 */
	add(atom: Atom): void {
		if (this.#storage) this.#storage.transaction(() => this.#add(atom));
		else this.#add(atom);
	}

	#add(atom: Atom): void {
		if (this.#storage && this.#storage.read("ordered-children", "format") !== 1) {
			if (this.#atoms.length !== 0) throw new Error("ordered children require fresh adoption");
			this.#storage.write("ordered-children", "format", 1);
		}

		validateShape(atom);
		const seq = this.#atoms.length;
		const bad = (why: string): never => {
			throw new EngineError("bad-atom", `atom ${atom.id}: ${why}`);
		};
		if (atom.seq !== seq || atom.id !== atomId(seq)) bad(`expected id ${atomId(seq)} with seq ${seq}`);

		const deps = new Set<AtomId>();
		for (const d of atom.deps) {
			if (!this.has(d)) bad(`dependency ${d} is not in the graph`);
			if (deps.has(d)) bad(`dependency ${d} listed twice`);
			deps.add(d);
		}
		for (const d of [...atom.needs, ...atom.resolves]) {
			if (!deps.has(d)) bad(`${d} is in needs/resolves but not in deps`);
		}
		for (const r of atom.reasons) if (!this.has(r.to)) bad(`reason points at unknown atom ${r.to}`);

		// Everything it touches must come from its closure. Derived deps name the
		// writers directly, so this is usually one lookup per writer.
		const below = new Map<AtomId, boolean>();
		const inClosure = (writer: AtomId): boolean => {
			let hit = below.get(writer);
			if (hit === undefined) {
				hit = deps.has(writer) || this.#reaches(deps, writer);
				below.set(writer, hit);
			}
			return hit;
		};
		const checkLine = (line: LineId, what: string): void => {
			const writer = this.lineAtom(line);
			if (writer === undefined) return bad(`${what} names unknown line ${line}`);
			if (!inClosure(writer)) bad(`${what} names line ${line} but ${writer} is not in its closure`);
		};

		for (const run of atom.inserts) {
			if (isStartNode(run.parent)) {
				if (run.parent !== startNode(run.file)) bad(`run in ${run.file} starts at ${run.parent}`);
			} else {
				// The parent may have been moved into run.file, so its own file can differ.
				checkLine(run.parent, "an insert");
			}
		}
		const moved = new Set<LineId>();
		for (const m of atom.moves ?? []) {
			checkLine(m.line, "a move");
			if (!isStartNode(m.parent)) checkLine(m.parent, "a move");
			if (m.line === m.parent) bad(`moves ${m.line} after itself`);
			if (moved.has(m.line)) bad(`moves ${m.line} twice`);
			moved.add(m.line);
			if (!atom.writes.includes(posKey(m.line)) || !atom.writes.includes(gapKey(m.parent))) {
				bad(`moves ${m.line} without writing ${posKey(m.line)} and ${gapKey(m.parent)}`);
			}
		}
		const deleted = new Set<LineId>();
		for (const line of atom.deletes) {
			checkLine(line, "a delete");
			if (deleted.has(line)) bad(`deletes ${line} twice`);
			deleted.add(line);
		}
		const writes = new Set(atom.writes);
		for (const line of deleted) if (!writes.has(lineKey(line))) bad(`deletes ${line} without writing ${lineKey(line)}`);
		for (const key of [...atom.writes, ...atom.reads, ...atom.holds]) {
			const parsed = parseKey(key);
			if (parsed.kind === "line") checkLine(parsed.node, `key ${key}`);
			else if ((parsed.kind === "gap" || parsed.kind === "pos") && !isStartNode(parsed.node))
				checkLine(parsed.node, `key ${key}`);
		}

		// Accept.
		const frozen = freezeAtom(
			atom,
			(id) => this.#atoms[seqOf(id)]!.id,
			(author) => {
				if (this.#storage) return author;
				let a = this.#authors.get(author);
				if (a === undefined) this.#authors.set(author, (a = author));
				return a;
			},
			this.#texts ? this.#reader(seq) : undefined,
			this.#lists ? this.#listReader(seq) : undefined,
		);
		this.#atoms.push(this.#storage ? atom : frozen);
		let lam = 0;
		for (const d of deps) lam = Math.max(lam, this.lamport(d) + 1);
		this.#lamport.push(lam);

		// The run starts' parents and the deleted lines, as codes, before this atom's own lines exist.
		// The atom as given: with lists kept elsewhere, the frozen one reads them back from the log.
		const deletes = atom.deletes.length > 0 ? new Set(atom.deletes) : undefined;
		const deletedN = atom.deletes.map((line) => this.#lineN(line));
		this.#atomDeletes.push(deletedN.length > 0 ? (this.#storage ? deletedN : Int32Array.from(deletedN)) : undefined);
		this.#lineBase.push(this.#lineTotal);
		for (const run of atom.inserts) {
			const file = this.#pathOf(run.file);
			let parent = isStartNode(run.parent) ? -1 - file : this.#lineN(run.parent);
			const first = this.#lineTotal;
			if (this.#storage)
				new OrderedIndex(this.#storage, "ordered-children", String(parent)).insert(
					orderedChildKey({
						n: first,
						replaces: deletes?.has(run.parent) ? 1 : 0,
						lamport: lam,
						seq,
						k: first - this.#lineBase[seq]!,
					}),
					first,
				);

			if (this.#runStartPages) this.#runStartPages.append(String(parent), first);
			else pushOne(this.#runStarts, parent, first);
			for (let i = 0; i < run.lines.length; i++) {
				const n = this.#lineTotal;
				this.#lineAtom.push(seq);
				this.#lineFile.push(file);
				this.#lineParent.push(parent);
				this.#lineText?.push(run.lines[i]!);
				this.#deleter.push(-1);
				this.#replacing.push(i === 0 && deletes?.has(run.parent) ? 1 : 0);
				parent = n;
			}
		}
		(frozen.moves ?? []).forEach((m, i) => {
			const info: RelocationInfo = Object.freeze({ atom: frozen.id, line: m.line, parent: m.parent, k: i });
			if (this.#relocationPages) this.#relocationPages.append(m.line, info);
			else pushIndex(this.#relocations, m.line, info);
			if (this.#relocatedToPages) this.#relocatedToPages.append(m.parent, info);
			else pushIndex(this.#relocatedTo, m.parent, info);
			const parentCode = isStartNode(m.parent) ? -1 - this.#pathOf(m.parent.slice(1)) : this.#lineN(m.parent);
			if (this.#relocatedToCodePages) this.#relocatedToCodePages.append(String(parentCode), info);
			else pushIndex(this.#relocatedToCode, parentCode, info);
		});
		if (frozen.moves) this.#movers.push(frozen.id);
		for (const n of deletedN) {
			if (this.#deleter.at(n) < 0) this.#deleter.set(n, seq);
			else if (this.#moreDeleterPages) this.#moreDeleterPages.append(String(n), seq);
			else pushIndex(this.#moreDeleters, n, seq);
		}
		for (const key of new Set(atom.writes)) {
			const code = this.#code(key);
			if (this.#writersPages) this.#writersPages.append(JSON.stringify([typeof code, code]), frozen.id);
			else pushOne(this.#writers, code, frozen.id);
		}
		for (const key of new Set(atom.reads)) {
			const code = this.#code(key);
			if (this.#readersPages) this.#readersPages.append(JSON.stringify([typeof code, code]), frozen.id);
			else pushOne(this.#readers, code, frozen.id);
		}
		for (const key of new Set(atom.holds)) {
			const code = this.#code(key);
			if (this.#holdersPages) this.#holdersPages.append(JSON.stringify([typeof code, code]), frozen.id);
			else pushOne(this.#holders, code, frozen.id);
		}
		for (const d of deps) {
			if (this.#dependentsPages) this.#dependentsPages.append(d, frozen.id);
			else pushOne(this.#dependents, d, frozen.id);
		}
		for (const r of new Set(frozen.resolves)) {
			if (this.#resolversPages) this.#resolversPages.append(r, frozen.id);
			else pushOne(this.#resolvers, r, frozen.id);
		}
		const files = new Set<string>();
		for (const run of atom.inserts) files.add(run.file);
		for (const n of deletedN) files.add(this.#paths[this.#lineFile.at(n)]!);
		for (const a of frozen.attrs ?? []) files.add(a.file);
		for (const m of frozen.moves ?? []) {
			files.add(this.lineFile(m.line)!);
			files.add(isStartNode(m.parent) ? m.parent.slice(1) : this.lineFile(m.parent)!);
		}
		this.#atomFiles.push(Object.freeze([...files].sort()));
		for (const file of files) {
			if (this.#fileAtomPages) this.#fileAtomPages.append(file, frozen.id);
			else pushIndex(this.#fileAtoms, file, frozen.id);
		}
		for (const r of frozen.reasons) {
			if (r.kind !== "together" || r.to === frozen.id) continue;

			const forward = { other: r.to, text: r.text, from: frozen.id };
			const reverse = { other: frozen.id, text: r.text, from: frozen.id };
			if (this.#togetherPages) {
				this.#togetherPages.append(frozen.id, forward);
				this.#togetherPages.append(r.to, reverse);
			} else {
				pushIndex(this.#together, frozen.id, forward);
				pushIndex(this.#together, r.to, reverse);
			}
		}
	}

	// Labels -----------------------------------------------------------------

	/**
	 * Add or replace a label. Label names may not look like atom ids. A base is
	 * resolved to its head only when it is used, never followed further, so
	 * bases may name each other in any shape.
	 */
	setLabel(label: Label): void {
		this.#putLabel(label, (name) => this.#labels.has(name));
	}

	#putLabel(label: Label, isLabel: (name: string) => boolean): void {
		const bad = (why: string): never => {
			throw new EngineError("bad-label", `label ${JSON.stringify(label?.name)}: ${why}`);
		};
		if (typeof label !== "object" || label === null) bad("not an object");
		if (typeof label.name !== "string" || label.name === "") bad("needs a name");
		if (isAtomId(label.name)) bad("a label name may not look like an atom id");
		if (!this.has(label.head)) bad(`head ${label.head} is not in the graph`);
		if (
			label.base !== undefined &&
			!(typeof label.base === "string" && (isLabel(label.base) || this.has(label.base)))
		) {
			bad(`base ${label.base} is neither a label nor an atom`);
		}
		if (label.base === label.name) bad("a label cannot be its own base");
		if (typeof label.title !== "string" || typeof label.message !== "string") bad("needs a title and message");
		if (label.follows !== undefined && !Array.isArray(label.follows)) bad("follows must be a list of label names");
		const copy: Label = {
			name: label.name,
			head: label.head,
			...(label.base !== undefined ? { base: label.base } : {}),
			title: label.title,
			message: label.message,
			...(label.follows !== undefined ? { follows: Object.freeze([...label.follows]) } : {}),
		};
		this.#labels.set(label.name, Object.freeze(copy));
	}

	label(name: string): Label | undefined {
		return this.#labels.get(name);
	}

	/** Labels sorted by name. */
	labels(): Label[] {
		return [...this.#labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/**
	 * Remove a label. Labels that used it as their base get its head atom as
	 * their base instead, so their contents don't change.
	 */
	removeLabel(name: string): boolean {
		return this.#storage ? this.#storage.transaction(() => this.#removeLabel(name)) : this.#removeLabel(name);
	}

	#removeLabel(name: string): boolean {
		const gone = this.#labels.get(name);
		if (!gone) return false;
		this.#labels.delete(name);
		for (const label of [...this.#labels.values()]) {
			if (label.base === name) this.#labels.set(label.name, Object.freeze({ ...label, base: gone.head }));
		}
		return true;
	}

	// JSON -------------------------------------------------------------------

	toJSON(): GraphJSON {
		return { format: GRAPH_FORMAT, version: 1, atoms: this.#atoms, labels: this.labels() };
	}

	/** Load a saved graph. Every atom is re-validated as it is added. */
	static fromJSON(data: unknown): Graph {
		const bad = (why: string): never => {
			throw new EngineError("bad-json", why);
		};
		if (typeof data !== "object" || data === null) bad("graph JSON must be an object");
		const obj = data as Partial<GraphJSON>;
		if (obj.format !== GRAPH_FORMAT) bad(`format must be ${GRAPH_FORMAT}`);
		if (obj.version !== 1) bad(`unsupported version ${String(obj.version)}`);
		if (!Array.isArray(obj.atoms) || !Array.isArray(obj.labels)) bad("atoms and labels must be arrays");
		const graph = new Graph();
		for (const atom of obj.atoms!) graph.add(atom);
		// Labels may name each other as bases, in any order and any shape.
		const names = new Set<string>();
		for (const label of obj.labels!) {
			const name: unknown = (label as Partial<Label> | null)?.name;
			if (typeof name !== "string") return bad("every label needs a name");
			if (names.has(name)) bad(`label ${name} appears twice`);
			names.add(name);
		}
		for (const label of obj.labels!) {
			try {
				graph.#putLabel(label, (name) => names.has(name));
			} catch (err) {
				if (err instanceof EngineError) bad(err.message);
				throw err;
			}
		}
		return graph;
	}

	#seq(id: AtomId): number {
		return typeof id === "string" ? seqOf(id) : -1;
	}
}

function validateShape(atom: Atom): void {
	const bad = (why: string): never => {
		throw new EngineError("bad-atom", `atom ${String((atom as { id?: unknown }).id)}: ${why}`);
	};
	if (typeof atom !== "object" || atom === null) bad("not an object");
	if (typeof atom.id !== "string" || !Number.isInteger(atom.seq)) bad("needs id and seq");
	if (typeof atom.author !== "string" || typeof atom.message !== "string") bad("needs author and message");
	if (typeof atom.time !== "number" || !Number.isFinite(atom.time)) bad("time must be a finite number");
	const lists = ["inserts", "deletes", "writes", "reads", "holds", "needs", "resolves", "reasons", "deps"] as const;
	for (const name of lists) if (!Array.isArray(atom[name])) bad(`${name} must be an array`);
	for (const run of atom.inserts as readonly InsertRun[]) {
		if (typeof run.file !== "string" || run.file === "" || run.file.includes("\n")) bad("a run needs a file path");
		if (typeof run.parent !== "string") bad("a run needs a parent");
		if (!Array.isArray(run.lines) || run.lines.length === 0) bad("a run needs at least one line");
		for (const text of run.lines) {
			if (typeof text !== "string" || text.includes("\n") || text.includes("\r"))
				bad("run lines must be strings without line breaks");
		}
	}
	if (atom.attrs !== undefined) {
		if (!Array.isArray(atom.attrs)) bad("attrs must be an array");
		for (const a of atom.attrs) {
			if (typeof a?.file !== "string" || a.file === "" || a.file.includes("\n") || !ATTR_NAMES.includes(a.name))
				bad("an attr needs a file and a name");
			if (a.value !== null && typeof a.value !== "string") bad("an attr value is a string or null");
			if (!atom.writes.includes(attrKey(a.file, a.name))) bad(`sets ${a.name} of ${a.file} without writing its key`);
		}
	}
	if (atom.moves !== undefined) {
		if (!Array.isArray(atom.moves) || atom.moves.length === 0) bad("moves must be a non-empty array");
		for (const m of atom.moves) {
			if (typeof m?.line !== "string" || typeof m.parent !== "string") bad("a move needs a line and a parent");
		}
	}
	for (const name of ["deletes", "writes", "reads", "holds", "needs", "resolves", "deps"] as const) {
		for (const x of atom[name]) if (typeof x !== "string") bad(`${name} must hold strings`);
	}
	for (const r of atom.reasons as readonly Reason[]) {
		if (typeof r.to !== "string" || typeof r.text !== "string" || !REASON_KINDS.includes(r.kind)) {
			bad("a reason needs to, kind (together, because-of or supersedes) and text");
		}
	}
}

/**
 * A frozen copy of an atom. An empty list is one shared frozen list, and atom
 * ids and authors are the graph's own strings (`canon`, `author`), so each is
 * kept once however often it's named (#46).
 */
function freezeAtom(
	atom: Atom,
	canon: (id: AtomId) => AtomId,
	author: (name: string) => string,
	text?: (start: number, length: number) => readonly string[],
	lists?: () => AtomLists,
): Atom {
	const list = <T>(xs: readonly T[], f?: (x: T) => T): readonly T[] =>
		xs.length === 0 ? EMPTY : Object.freeze(f ? xs.map(f) : [...xs]);
	// With text kept elsewhere (#46), a run's lines are read when asked for.
	let k = 0;
	const run = (r: InsertRun): InsertRun => {
		if (!text) return Object.freeze({ file: r.file, parent: r.parent, lines: Object.freeze([...r.lines]) });
		const start = k;
		const length = r.lines.length;
		k += length;
		return Object.freeze(new LazyRun(r.file, r.parent, text, start, length));
	};
	const copy: Atom = {
		id: atom.id,
		seq: atom.seq,
		author: author(atom.author),
		message: atom.message,
		time: atom.time,
		inserts: Object.freeze(atom.inserts.map(run)),
		...(lists
			? {}
			: { deletes: list(atom.deletes), writes: list(atom.writes), reads: list(atom.reads), holds: list(atom.holds) }),
		needs: list(atom.needs, canon),
		resolves: list(atom.resolves, canon),
		reasons: list(atom.reasons, (r) => Object.freeze({ to: canon(r.to), kind: r.kind, text: r.text })),
		deps: list(atom.deps, canon),
		...(atom.attrs && atom.attrs.length > 0
			? { attrs: Object.freeze(atom.attrs.map((a) => Object.freeze({ file: a.file, name: a.name, value: a.value }))) }
			: {}),
		...(atom.moves
			? { moves: Object.freeze(atom.moves.map((m) => Object.freeze({ line: m.line, parent: m.parent }))) }
			: {}),
	} as Atom;
	return Object.freeze(lists ? (new ListedAtom(copy, lists) as unknown as Atom) : copy);
}
