// Sets of atoms: closure, closedness, history order, and drop.

import type { Graph } from "./graph.ts";
import { type Atom, type AtomId, type AtomSet, EngineError } from "./types.ts";

/** The atoms plus everything they depend on, transitively. */
export function closure(graph: Graph, ids: Iterable<AtomId>): Set<AtomId> {
	return graph.closureOf(ids);
}

/** Atoms of the set whose deps are not all in the set, with what is missing. */
export function missingDeps(graph: Graph, set: AtomSet): { atom: AtomId; missing: AtomId[] }[] {
	const out: { atom: AtomId; missing: AtomId[] }[] = [];
	for (const id of sortBySeq(graph, set)) {
		const missing = graph.atom(id).deps.filter((d) => !set.has(d));
		if (missing.length > 0) out.push({ atom: id, missing });
	}
	return out;
}

/** Every atom's dependencies are in the set. */
export function isClosed(graph: Graph, set: AtomSet): boolean {
	for (const id of set) for (const d of graph.atom(id).deps) if (!set.has(d)) return false;
	return true;
}

/**
 * History: the set in ascending priority (lamport, then seq). This is a
 * topological order (deps always have lower lamport). Atoms with no path
 * between them have no real order; their `deps` show which pairs are ordered.
 */
export function history(graph: Graph, set: Iterable<AtomId>): Atom[] {
	return [...set].sort((a, b) => graph.comparePriority(a, b)).map((id) => graph.atom(id));
}

/** Atoms in the set that depend on `id`, transitively (not including `id`). */
export function dependentsIn(graph: Graph, set: AtomSet, id: AtomId): Set<AtomId> {
	const out = new Set<AtomId>();
	const stack = [id];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		for (const d of graph.eachDependentOf(cur)) {
			if (set.has(d) && !out.has(d)) {
				out.add(d);
				stack.push(d);
			}
		}
	}
	return out;
}

/** Remove an atom and everything in the set that depends on it. Returns the new set and what left. */
export function drop(graph: Graph, set: AtomSet, id: AtomId): { set: Set<AtomId>; removed: AtomId[] } {
	if (!set.has(id)) throw new EngineError("not-in-set", `${id} is not in the set`);
	const gone = dependentsIn(graph, set, id);
	gone.add(id);
	const kept = new Set<AtomId>();
	for (const x of set) if (!gone.has(x)) kept.add(x);
	return { set: kept, removed: sortBySeq(graph, gone) };
}

/**
 * What a pluck takes: the closure of `ids`, widened so that every group is
 * all in or all out. `groupOf(id)` lists the atoms that travel with `id` (a
 * git commit's hunks and its tie; just `id` when it belongs to no group).
 * Whenever any atom of a group is in, the whole group and the closure of each
 * of its atoms come too, repeated until nothing changes. The result is closed.
 */
export function pluckClosure(
	graph: Graph,
	ids: Iterable<AtomId>,
	groupOf: (id: AtomId) => readonly AtomId[],
): Set<AtomId> {
	const out = new Set<AtomId>();
	const stack = [...ids];
	for (const id of stack) graph.atom(id);
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (out.has(id)) continue;
		out.add(id);
		for (const d of graph.atom(id).deps) if (!out.has(d)) stack.push(d);
		for (const g of groupOf(id)) if (!out.has(g)) stack.push(g);
	}
	return out;
}

export function sortBySeq(graph: Graph, ids: Iterable<AtomId>): AtomId[] {
	return [...ids].sort((a, b) => graph.atom(a).seq - graph.atom(b).seq);
}
