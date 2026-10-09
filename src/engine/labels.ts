// Labels: what git calls commits. A label is a head atom plus everything it
// needed, minus a base. Labels are stored on the graph (graph.setLabel).

import type { Graph } from "./graph.ts";
import { history } from "./sets.ts";
import { type AtomId, EngineError, type Label } from "./types.ts";

/** A label name or an atom id, resolved to an atom id (a label resolves to its head). */
export function resolveRef(graph: Graph, ref: string): AtomId {
	const label = graph.label(ref);
	if (label) return label.head;
	if (graph.has(ref)) return ref;
	throw new EngineError("unknown-ref", `${ref} is neither a label nor an atom`);
}

/** The full state a ref names: the closure of the atom (or the label's head). */
export function stateOf(graph: Graph, ref: string): ReadonlySet<AtomId> {
	return graph.closure(resolveRef(graph, ref));
}

/**
 * A label's contents, in history order: closure(head) minus closure(base);
 * without a base, minus a0.
 */
export function labelContents(graph: Graph, label: Pick<Label, "head" | "base">): AtomId[] {
	const include = graph.closure(label.head);
	const exclude: ReadonlySet<AtomId> = label.base !== undefined ? stateOf(graph, label.base) : new Set(["a0"]);
	return history(
		graph,
		[...include].filter((id) => !exclude.has(id)),
	).map((a) => a.id);
}

/**
 * Re-slice: any atom inside a label defines a smaller label (that atom plus
 * its own closure, same base). Returns that smaller label's contents.
 */
export function reslice(graph: Graph, label: Pick<Label, "head" | "base">, atom: AtomId): AtomId[] {
	if (!labelContents(graph, label).includes(atom)) {
		throw new EngineError("not-in-set", `${atom} is not inside the label`);
	}
	return labelContents(graph, { head: atom, ...(label.base !== undefined ? { base: label.base } : {}) });
}

/** Labels whose contents include the atom (for "why" output). */
export function labelsContaining(graph: Graph, atom: AtomId): Label[] {
	return graph.labels().filter((l) => labelContents(graph, l).includes(atom));
}
