// Conflicts, reason warnings, and the check a draft atom gets before it is
// accepted into a set.

import type { Graph } from "./graph.ts";
import { isStartNode, lineId, lineOfKey, parseKey, writerOf } from "./keys.ts";
import type { Atom, AtomId, AtomSet, Key, LineId } from "./types.ts";
import { View } from "./view.ts";

/** How the non-writing side relates to a key the other side writes. */
export type Relation = "write" | "read" | "hold";

/** One overlapping key: `writer` writes it; `other` writes, reads or holds it. */
export interface ConflictKey {
	readonly key: Key;
	readonly writer: AtomId;
	readonly other: AtomId;
	readonly relation: Relation;
}

export interface Side {
	readonly atom: AtomId;
	readonly author: string;
	readonly message: string;
}

/**
 * Two atoms whose claims overlap where at least one side writes: either they
 * are independent, or the later one writes into a hold of the earlier one
 * without naming it in needs or resolves. kind is 'semantic' when every
 * overlap is an edit against a hold (reliesOn, wide, claim span), otherwise
 * 'edit-edit'.
 */
export interface Conflict {
	/** The two atoms, lower seq first. */
	readonly atoms: readonly [AtomId, AtomId];
	readonly kind: "edit-edit" | "semantic";
	readonly keys: readonly ConflictKey[];
	readonly sides: readonly [Side, Side];
	/** Atoms in the set whose `resolves` names both sides. Empty means unresolved. */
	readonly resolvedBy: readonly AtomId[];
}

interface KeySets {
	readonly writes: ReadonlySet<Key>;
	readonly reads: ReadonlySet<Key>;
	readonly holds: ReadonlySet<Key>;
}

const keySetCache = new WeakMap<Atom, KeySets>();

function keySets(atom: Atom): KeySets {
	let sets = keySetCache.get(atom);
	if (!sets) {
		sets = { writes: new Set(atom.writes), reads: new Set(atom.reads), holds: new Set(atom.holds) };
		keySetCache.set(atom, sets);
	}
	return sets;
}

function relationTo(sets: KeySets, key: Key): Relation | undefined {
	if (sets.writes.has(key)) return "write";
	if (sets.reads.has(key)) return "read";
	if (sets.holds.has(key)) return "hold";
	return undefined;
}

/** All keys of an atom it claims: reads ∪ holds ∪ writes. */
export function claimsOf(atom: Atom): Key[] {
	return [...new Set([...atom.writes, ...atom.reads, ...atom.holds])].sort();
}

/**
 * The overlap between two atoms' claims that would make them conflict if they
 * were independent: writes(a) ∩ claims(b) and writes(b) ∩ claims(a).
 * Read-read and hold-hold overlap never count. A key both write is listed
 * once, with `a` as the writer.
 */
export function keyOverlap(a: Atom, b: Atom): ConflictKey[] {
	const ka = keySets(a);
	const kb = keySets(b);
	const out: ConflictKey[] = [];
	for (const key of ka.writes) {
		const relation = relationTo(kb, key);
		if (relation) out.push({ key, writer: a.id, other: b.id, relation });
	}
	for (const key of kb.writes) {
		if (ka.writes.has(key)) continue; // already listed as write-write
		const relation = relationTo(ka, key);
		if (relation) out.push({ key, writer: b.id, other: a.id, relation });
	}
	return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.writer < y.writer ? -1 : 1));
}

/** Neither atom is in the other's dependency closure. */
export function independent(graph: Graph, a: AtomId, b: AtomId): boolean {
	return a !== b && !graph.dependsOn(a, b) && !graph.dependsOn(b, a);
}

/** Whether `atom` names `holder` in its needs or resolves: the one way to release a hold. */
export function releases(atom: Atom, holder: AtomId): boolean {
	return atom.needs.includes(holder) || atom.resolves.includes(holder);
}

/**
 * The keys two atoms conflict over (empty when they don't). `a` has the lower
 * seq, so `b` is never in `a`'s closure; `aBelowB` says whether `a` is in
 * `b`'s. Independent atoms conflict over their keyOverlap. When `b` built on
 * `a`, only the holds of `a` that `b` writes count, and only while `b` doesn't
 * name `a` in needs or resolves: a hold is released on purpose, never by a
 * dependency derived from neighbouring lines.
 */
export function conflictKeys(a: Atom, b: Atom, aBelowB: boolean): ConflictKey[] {
	if (!aBelowB) return keyOverlap(a, b);
	if (releases(b, a.id)) return [];
	const held = keySets(a).holds;
	return [...keySets(b).writes]
		.filter((key) => held.has(key))
		.sort()
		.map((key) => ({ key, writer: b.id, other: a.id, relation: "hold" }));
}

function side(atom: Atom): Side {
	return { atom: atom.id, author: atom.author, message: atom.message };
}

/** `a` has the lower seq. */
function makeConflict(graph: Graph, set: AtomSet | undefined, a: Atom, b: Atom, keys: ConflictKey[]): Conflict {
	const kind = keys.every((k) => k.relation === "hold") ? "semantic" : "edit-edit";
	const resolvedBy: AtomId[] = [];
	if (set) {
		// Resolver indexes append in sequence order: intersect without copying either history.
		const left = graph.eachResolverOf(a.id);
		const right = graph.eachResolverOf(b.id);
		let p = left.next();
		let q = right.next();
		while (!p.done && !q.done) {
			const order = graph.atom(p.value).seq - graph.atom(q.value).seq;
			if (order === 0 && set.has(p.value)) resolvedBy.push(p.value);
			if (order <= 0) p = left.next();
			if (order >= 0) q = right.next();
		}
	}
	return { atoms: [a.id, b.id], kind, keys, sides: [side(a), side(b)], resolvedBy };
}

/** Atoms in the set that claim (write, read or hold) a key. */
function* claimersIn(graph: Graph, set: AtomSet, key: Key): IterableIterator<AtomId> {
	for (const list of [graph.eachWriterOf(key), graph.eachReaderOf(key), graph.eachHolderOf(key)]) {
		for (const id of list) if (set.has(id)) yield id;
	}
}

const bySeq =
	(graph: Graph) =>
	(p: AtomId, q: AtomId): number =>
		graph.atom(p).seq - graph.atom(q).seq;

/**
 * Every conflict in a set, resolved ones included (see `resolvedBy`), ordered
 * by the two atoms' seqs. A conflict between A and B is resolved when the set
 * holds an atom whose `resolves` names both.
 */
export function conflicts(graph: Graph, set: AtomSet): Conflict[] {
	const pairs = new Map<string, [AtomId, AtomId]>();
	for (const id of set) {
		for (const key of graph.atom(id).writes) {
			for (const other of claimersIn(graph, set, key)) {
				if (other === id) continue;
				const [a, b] = graph.atom(id).seq < graph.atom(other).seq ? [id, other] : [other, id];
				pairs.set(`${a} ${b}`, [a, b]);
			}
		}
	}
	const out: Conflict[] = [];
	for (const [a, b] of pairs.values()) {
		const x = graph.atom(a);
		const y = graph.atom(b);
		const keys = conflictKeys(x, y, graph.dependsOn(b, a));
		if (keys.length > 0) out.push(makeConflict(graph, set, x, y, keys));
	}
	return out.sort((p, q) => bySeq(graph)(p.atoms[0], q.atoms[0]) || bySeq(graph)(p.atoms[1], q.atoms[1]));
}

/** Conflicts in the set that no atom in the set resolves. */
export function unresolvedConflicts(graph: Graph, set: AtomSet): Conflict[] {
	return conflicts(graph, set).filter((c) => c.resolvedBy.length === 0);
}

// Reason warnings ----------------------------------------------------------------

export interface ReasonWarning {
	/** The atom whose lines the new atom changed. */
	readonly atom: AtomId;
	/** The atom it was changed together with. */
	readonly partner: AtomId;
	readonly text: string;
	readonly message: string;
}

/** Whether a line has the next line of its own run hanging off it (an insert after it lands inside the run). */
function insideRun(graph: Graph, line: LineId): boolean {
	const info = graph.line(line);
	return info !== undefined && graph.line(lineId(info.atom, info.k + 1))?.parent === line;
}

/** The nearest visible lines above and below a line in the view's sequence of its file. */
function visibleNeighbours(view: View, graph: Graph, line: LineId): LineId[] {
	const info = graph.line(line);
	if (!info) return [];
	const sequence = view.sequence(info.file);
	const at = view.sequenceIndex(info.file, line);
	if (at < 0) return [];
	const out: LineId[] = [];
	for (let i = at - 1; i >= 0; i--) {
		if (sequence[i]!.visible) {
			out.push(sequence[i]!.id);
			break;
		}
	}
	for (let i = at + 1; i < sequence.length; i++) {
		if (sequence[i]!.visible) {
			out.push(sequence[i]!.id);
			break;
		}
	}
	return out;
}

/**
 * When atom N changes A's lines (deletes one, or inserts between two lines of
 * one run of A), A has a `together` reason with B (either direction), B is in
 * the set, and N doesn't touch B's side, warn. N touches B's side when it
 * writes, reads or holds a line B wrote, or a line right next to one B
 * deleted (a deletion leaves no lines of its own). No warning when N itself
 * carries a reason to B (it has said why B is fine).
 */
export function reasonWarnings(graph: Graph, set: AtomSet, atom: Atom): ReasonWarning[] {
	const claimed = new Set<LineId>();
	for (const key of claimsOf(atom)) {
		const line = lineOfKey(key);
		if (line !== undefined) claimed.add(line);
	}
	const touched = new Set<AtomId>([...claimed].map(writerOf));
	const changed = new Set<AtomId>();
	for (const key of atom.writes) {
		const { kind, node } = parseKey(key);
		if (kind === "line") changed.add(writerOf(node));
		else if (kind === "gap" && !isStartNode(node) && insideRun(graph, node)) changed.add(writerOf(node));
	}
	let view: View | undefined;
	const touchesSide = (b: AtomId): boolean => {
		if (touched.has(b)) return true;
		const deleted = graph.atom(b).deletes;
		if (deleted.length === 0) return false;
		view ??= new View(graph, set);
		const v = view;
		return deleted.some((line) => visibleNeighbours(v, graph, line).some((n) => claimed.has(n)));
	};
	const acknowledged = new Set(atom.reasons.map((r) => r.to));
	const out: ReasonWarning[] = [];
	const seen = new Set<string>();
	for (const a of [...changed].sort(bySeq(graph))) {
		if (a === atom.id) continue;
		for (const link of graph.eachTogetherLink(a)) {
			const b = link.other;
			if (b === atom.id || !set.has(b) || acknowledged.has(b)) continue;
			const tag = `${a} ${b}`;
			if (seen.has(tag)) continue;
			seen.add(tag);
			if (touchesSide(b)) continue;
			out.push({
				atom: a,
				partner: b,
				text: link.text,
				message: `${a} was changed together with ${b} because: ${link.text}; you changed ${a}'s lines but not ${b}'s.`,
			});
		}
	}
	return out;
}

// Draft check ----------------------------------------------------------------------

/** Whose lines a draft touches, and how. */
export interface Touch {
	readonly atom: AtomId;
	readonly author: string;
	readonly message: string;
	readonly writes: readonly LineId[];
	readonly reads: readonly LineId[];
	readonly holds: readonly LineId[];
}

export interface DraftReport {
	readonly touches: readonly Touch[];
	/** Conflicts the draft would have with atoms in the set (none are resolved yet). */
	readonly conflicts: readonly Conflict[];
	readonly warnings: readonly ReasonWarning[];
}

/**
 * What accepting `draft` into `set` would mean, before it is accepted: whose
 * lines it touches (with author and message), the conflicts it would bring
 * (exactly those `conflicts` reports once it is in the set), and reason
 * warnings. The draft must not be in the graph yet; its deps must be.
 */
export function checkDraft(graph: Graph, set: AtomSet, draft: Atom): DraftReport {
	const below = graph.closureOf(draft.deps);
	const candidates = new Set<AtomId>();
	for (const key of draft.writes) for (const id of claimersIn(graph, set, key)) candidates.add(id);
	for (const key of claimsOf(draft)) for (const id of graph.eachWriterOf(key)) if (set.has(id)) candidates.add(id);
	const found: Conflict[] = [];
	for (const id of [...candidates].sort(bySeq(graph))) {
		const other = graph.atom(id);
		const keys = conflictKeys(other, draft, below.has(id));
		if (keys.length > 0) found.push(makeConflict(graph, undefined, other, draft, keys));
	}
	return { touches: touchesOf(graph, draft), conflicts: found, warnings: reasonWarnings(graph, set, draft) };
}

/** Group the lines an atom writes, reads and holds by the atom that wrote them. */
export function touchesOf(graph: Graph, atom: Atom): Touch[] {
	const by = new Map<AtomId, { writes: LineId[]; reads: LineId[]; holds: LineId[] }>();
	const add = (keys: readonly Key[], field: "writes" | "reads" | "holds"): void => {
		for (const key of keys) {
			const line = lineOfKey(key);
			if (line === undefined) continue;
			const writer = writerOf(line);
			if (writer === atom.id) continue;
			let entry = by.get(writer);
			if (!entry) {
				entry = { writes: [], reads: [], holds: [] };
				by.set(writer, entry);
			}
			entry[field].push(line);
		}
	};
	add(atom.writes, "writes");
	add(atom.reads, "reads");
	add(atom.holds, "holds");
	return [...by.entries()]
		.sort(([p], [q]) => graph.atom(p).seq - graph.atom(q).seq)
		.map(([id, lines]) => {
			const a = graph.atom(id);
			return { atom: id, author: a.author, message: a.message, ...lines };
		});
}
