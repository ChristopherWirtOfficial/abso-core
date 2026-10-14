// Collisions (#11, #37): which draft changes collide with other work by the
// engine's rule, how a collision reads, who published the other side, and
// duplicate top-level names. The project calls these and decides who hears what.

import {
	type AtomId,
	type ConflictKey,
	claimsOf,
	conflictKeys,
	type Graph,
	joinLines,
	parseKey,
	type ReadView,
} from "../../src/engine/index.ts";
import { differenceSet, StableOverlaySet } from "../../src/engine/state-source.ts";
import { definedTwice } from "./definitions.ts";
import type { AgentState, Collision, CollisionSide } from "./project-types.ts";
import { SHARED, type Space } from "./spaces.ts";

export interface Pair {
	readonly yours: AtomId;
	readonly theirs: AtomId;
	readonly keys: readonly ConflictKey[];
}

/** Where a published atom came from. */
export interface Origin {
	readonly agent: string;
	readonly message: string;
	readonly version: number;
	readonly draft?: string;
}

/** A line too plain to identify on its own: blank, or only brackets and punctuation. */
export const PLAIN_LINE = /^[\s{}()[\];,.]*$/;

/**
 * Pairs of a draft change and an atom of `against` that collide by the
 * engine's rule, and that no atom of `settled` resolves.
 */
export function pairsIn(
	g: Graph,
	draft: readonly AtomId[],
	against: ReadonlySet<AtomId>,
	settled: ReadonlySet<AtomId>,
): Pair[] {
	const out: Pair[] = [];
	for (const yours of draft) {
		const atom = g.atom(yours);
		const streams: IterableIterator<AtomId>[] = [];
		for (const key of atom.writes) {
			streams.push(g.eachWriterOf(key), g.eachReaderOf(key), g.eachHolderOf(key));
		}
		for (const key of claimsOf(atom)) streams.push(g.eachWriterOf(key));
		for (const theirs of orderedClaimants(g, streams)) {
			if (!against.has(theirs)) continue;
			const [lo, hi] = g.atom(yours).seq < g.atom(theirs).seq ? [yours, theirs] : [theirs, yours];
			const keys = conflictKeys(g.atom(lo), g.atom(hi), g.dependsOn(hi, lo));
			if (keys.length === 0 || sideBySide(g, lo, hi, keys)) continue;
			if (hasCommonResolver(g, lo, hi, settled)) continue;
			out.push({ yours, theirs, keys });
		}
	}
	return out;
}

/** Claim indexes append in canonical seq order. Merge one cursor per current
 * atom key, retaining no candidate set proportional to historical claims. */
function* orderedClaimants(g: Graph, streams: IterableIterator<AtomId>[]): IterableIterator<AtomId> {
	try {
		type Head = { id: AtomId; seq: number; stream: number };
		const heap: Head[] = [];
		const less = (a: Head, b: Head) => a.seq < b.seq || (a.seq === b.seq && a.stream < b.stream);
		const push = (head: Head) => {
			let at = heap.length;
			heap.push(head);
			while (at > 0) {
				const parent = (at - 1) >>> 1;
				if (!less(head, heap[parent]!)) break;
				heap[at] = heap[parent]!;
				at = parent;
			}
			heap[at] = head;
		};
		const advance = (stream: number) => {
			const next = streams[stream]!.next();
			if (!next.done) push({ id: next.value, seq: g.atom(next.value).seq, stream });
		};
		for (let stream = 0; stream < streams.length; stream++) advance(stream);
		let previous = -1;
		while (heap.length) {
			const head = heap[0]!;
			const tail = heap.pop()!;
			if (heap.length) {
				let at = 0;
				while (at * 2 + 1 < heap.length) {
					let child = at * 2 + 1;
					if (child + 1 < heap.length && less(heap[child + 1]!, heap[child]!)) child++;
					if (!less(heap[child]!, tail)) break;
					heap[at] = heap[child]!;
					at = child;
				}
				heap[at] = tail;
			}
			advance(head.stream);
			if (head.seq === previous) continue;
			previous = head.seq;
			yield head.id;
		}
	} finally {
		for (const stream of streams) stream.return?.();
	}
}

/** Resolver indexes share the same append order, so intersection needs two cursors. */
function hasCommonResolver(g: Graph, lo: AtomId, hi: AtomId, settled: ReadonlySet<AtomId>): boolean {
	const left = g.eachResolverOf(lo);
	const right = g.eachResolverOf(hi);
	try {
		let a = left.next();
		let b = right.next();
		while (!a.done && !b.done) {
			const x = g.atom(a.value).seq;
			const y = g.atom(b.value).seq;
			if (x === y && settled.has(a.value)) return true;
			if (x <= y) a = left.next();
			if (y <= x) b = right.next();
		}
		return false;
	} finally {
		left.return?.();
		right.return?.();
	}
}

/**
 * Two pure insertions at the same point, and nothing else between them
 * (#37, the game trial): both only write the gap after one line. Neither
 * loses anything (both are kept, one after the other), so that alone is
 * not a collision. It still is when they share a line with real content (the
 * same import added twice would be doubled), or when the gap is the top of
 * a file (two agents creating the same file).
 */
function sideBySide(g: Graph, a: AtomId, b: AtomId, keys: readonly ConflictKey[]): boolean {
	const gaps = new Set<string>();
	for (const k of keys) {
		if (k.relation !== "write" || !k.key.startsWith("G:") || k.key.startsWith("G:^")) return false;
		gaps.add(k.key.slice(2));
	}
	const linesAt = (id: AtomId): Set<string> => {
		const out = new Set<string>();
		for (const run of g.atom(id).inserts) {
			if (!gaps.has(run.parent)) continue;
			for (const l of run.lines) if (!PLAIN_LINE.test(l)) out.add(l.trim());
		}
		return out;
	};
	const ours = linesAt(a);
	for (const l of linesAt(b)) if (ours.has(l)) return false;
	return true;
}

/** Describe a pair for the agent: its side in `yoursView`, theirs in `theirsView`, with who published theirs. */
export function describePair(
	g: Graph,
	origin: (atom: AtomId, spaceName: string) => Origin,
	pair: Pair,
	yoursView: ReadView,
	theirsView: ReadView,
	spaceName: string,
): Collision {
	const file = fileOfKey(pair.keys[0]!.key, yoursView);
	const fileKeys = pair.keys.filter((k) => fileOfKey(k.key, yoursView) === file).map((k) => k.key);
	const attrsOnly = fileKeys.map((k) => parseKey(k)).filter((k) => k.kind === "attr");
	if (attrsOnly.length === fileKeys.length) {
		// Both set the same attribute of the file: show each side's value.
		const name = attrsOnly[0]!.attr!;
		const valueIn = (view: ReadView, atom: AtomId): string => {
			const set = (g.atom(atom).attrs ?? []).find((a) => a.file === file && a.name === name);
			return set?.value ?? (name === "exec" ? "" : String(view.attrs(file)[name] ?? ""));
		};
		return {
			kind: "attribute",
			name,
			file,
			yours: { lines: [1, 0], text: valueIn(yoursView, pair.yours) },
			theirs: { lines: [1, 0], text: valueIn(theirsView, pair.theirs), ...origin(pair.theirs, spaceName) },
		};
	}
	return {
		kind: "lines",
		file,
		yours: describeSide(yoursView, pair.yours, file, fileKeys),
		theirs: { ...describeSide(theirsView, pair.theirs, file, fileKeys), ...origin(pair.theirs, spaceName) },
	};
}

export function fileOfKey(key: string, view: ReadView): string {
	const { kind, node } = parseKey(key);
	if (kind === "attr") return node;
	return node.startsWith("^") ? node.slice(1) : view.fileOf(node);
}

/**
 * The files some atoms change: the graph's files of each, and, in views
 * with moves (#28), wherever the lines they touch are in those views.
 */
export function touchedFiles(g: Graph, ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string> {
	const out = new Set<string>();
	const moved = views.filter((v) => v.hasMoves());
	for (const id of ids) {
		for (const file of g.filesOf(id)) out.add(file);
		if (moved.length === 0) continue;
		const atom = g.atom(id);
		const lines: string[] = [...g.deletedLines(id)];
		for (const run of atom.inserts) if (!run.parent.startsWith("^")) lines.push(run.parent);
		for (const m of atom.moves ?? []) {
			lines.push(m.line);
			if (!m.parent.startsWith("^")) lines.push(m.parent);
		}
		for (const v of moved) for (const line of lines) out.add(v.fileOf(line));
	}
	return out;
}

/** The atom's visible lines in a file of a view, or where it acted when none are left. */
export function describeSide(view: ReadView, atom: AtomId, file: string, keys: readonly string[]): CollisionSide {
	const visible = view.lines(file);
	let first = -1;
	let lastLine = -1;
	visible.forEach((line, i) => {
		if (line.atom === atom) {
			if (first < 0) first = i;
			lastLine = i;
		}
	});
	if (first >= 0) {
		return { lines: [first + 1, lastLine + 1], text: joinLines(visible.slice(first, lastLine + 1).map((l) => l.text)) };
	}
	// No lines of its own here (a deletion): point at where the first key sits.
	let at = 1;
	const { node } = parseKey(keys[0]!);
	if (!node.startsWith("^")) {
		const sequence = view.sequence(file);
		const index = view.sequenceIndex(file, node);
		at = 1 + sequence.slice(0, Math.max(index, 0)).filter((l) => l.visible).length;
	}
	return { lines: [at, at - 1], text: "" };
}

/** What origin, open pairs and duplicate-name collisions need from a project. */
export interface CollisionHost {
	readonly graph: Graph;
	readonly spaces: ReadonlyMap<string, Space>;
	version(): number;
	spaceOf(agent: AgentState): Space;
	agentSet(agent: AgentState): ReadonlySet<AtomId>;
	draft(agent: AgentState): AtomId[];
	agentView(agent: AgentState): ReadView;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	shared(): Space;
}

/** Who published an atom, looking in the given space first and then in shared. */
export function originOf(host: CollisionHost, atom: AtomId, spaceName: string): Origin {
	for (const name of [spaceName, SHARED]) {
		const space = host.spaces.get(name)!;
		const version = space.publishedIn.get(atom);
		if (version === undefined) continue;
		const p = space.versions[version]!;
		return { agent: p.agent, message: p.message, version, ...(name !== SHARED ? { draft: name } : {}) };
	}
	return { agent: host.graph.atom(atom).author, message: "", version: host.version() };
}

/**
 * Draft changes that build on atoms a set doesn't have (a drop took them
 * out): the files they touch. Those changes can't move onto that set.
 */
export function strandedFiles(g: Graph, draft: readonly AtomId[], set: ReadonlySet<AtomId>): string[] {
	const mine = new Set(draft);
	const files = new Set<string>();
	for (const id of draft) {
		if (g.atom(id).deps.some((d) => !set.has(d) && !mine.has(d))) for (const f of g.filesOf(id)) files.add(f);
	}
	return [...files].toSorted();
}

/**
 * Names the agent's draft defines at the top level of a file where other
 * work defines them too, so they are defined twice there (#25, Fuzzer).
 */
export function duplicateCollisions(host: CollisionHost, agent: AgentState): Collision[] {
	const draft = host.draft(agent);
	if (draft.length === 0) return [];
	const mine = new Set(draft);
	const view = host.agentView(agent);
	const space = host.spaceOf(agent);
	const out: Collision[] = [];
	for (const file of [...touchedFiles(host.graph, draft, [view])].toSorted()) {
		if (!view.hasFile(file)) continue;
		for (const [name, defs] of definedTwice(view, file)) {
			const yours = defs.find((d) => d.lines.some((l) => mine.has(host.graph.line(l)!.atom)));
			const theirs = defs.find((d) => d.lines.every((l) => !mine.has(host.graph.line(l)!.atom)));
			if (!yours || !theirs) continue;
			const by = host.graph.line(theirs.lines[0]!)!.atom;
			out.push({
				kind: "duplicate",
				name,
				file,
				yours: { lines: [yours.start + 1, yours.end], text: `${yours.text}\n` },
				theirs: { lines: [theirs.start + 1, theirs.end], text: `${theirs.text}\n`, ...originOf(host, by, space.name) },
			});
		}
	}
	return out;
}

/**
 * Collisions the agent has synced into and not settled: its draft against
 * its space at its base. In a named draft, also the draft's own changes
 * against shared work the draft was moved onto.
 */
export function openPairs(host: CollisionHost, agent: AgentState): Pair[] {
	const space = host.spaceOf(agent);
	const set = host.agentSet(agent);
	const mine = new StableOverlaySet(agent.mine);
	const out: Pair[] = [];
	const draft = host.draft(agent);
	if (draft.length > 0) {
		const seen = differenceSet(host.at(space, agent.base), mine);
		out.push(...pairsIn(host.graph, draft, seen, set));
	}
	if (space.name !== SHARED) {
		const shared = host.shared();
		const pending = [...space.own].filter((id) => set.has(id) && !shared.own.has(id));
		const sharedSeen = new Set([...set].filter((id) => shared.own.has(id)));
		out.push(...pairsIn(host.graph, pending, sharedSeen, set));
	}
	return out;
}
