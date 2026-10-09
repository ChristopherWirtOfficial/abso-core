// Build a draft change against the agent's view. Writes go through
// AddDraftHost; today the host is Project.

import {
	type Atom,
	type AtomId,
	type AttrSet,
	buildAtom,
	claimsOf,
	type EditInput,
	type Graph,
	type MoveInput,
	parseKey,
	type View,
} from "../../src/engine/index.ts";
import type { Pair } from "./collisions.ts";
import type { AgentState, Entry, Meta } from "./project-types.ts";

/** What building a draft change needs from a project. */
export interface AddDraftHost {
	readonly graph: Graph;
	openPairs(agent: AgentState): Pair[];
	markersSettled(agent: AgentState, view: View, atom: Atom): AtomId[];
	apply(entry: Entry): void;
}

/**
 * Build a draft change against the agent's view. If it touches lines on
 * either side of a collision the agent has already seen, it settles that
 * collision (the engine's `resolves`).
 */
export function addDraft(
	host: AddDraftHost,
	agent: AgentState,
	view: View,
	input: { edits: readonly EditInput[]; attrs?: readonly AttrSet[]; move?: MoveInput },
	time: number,
	meta: Meta,
	entries: Entry[],
): void {
	const base = {
		author: agent.name,
		message: "",
		time,
		edits: input.edits,
		...(input.attrs?.length ? { attrs: input.attrs } : {}),
		...(input.move ? { move: input.move } : {}),
	};
	let atom = buildAtom(view, base);
	const touched = new Set<AtomId>();
	for (const key of claimsOf(atom)) {
		const { kind, node } = parseKey(key);
		if (kind === "line") touched.add(host.graph.line(node)!.atom);
		// Setting an attribute again settles a collision over it.
		if (kind === "attr") for (const w of host.graph.writersOf(key)) touched.add(w);
	}
	const resolves = new Set<AtomId>();
	for (const p of host.openPairs(agent)) {
		if (touched.has(p.yours) || touched.has(p.theirs)) {
			resolves.add(p.yours);
			resolves.add(p.theirs);
		}
	}
	// Taking out a block's markers settles the changes that collided there (#11).
	for (const id of host.markersSettled(agent, view, atom)) resolves.add(id);
	if (resolves.size > 0) atom = buildAtom(view, { ...base, resolves: [...resolves] });
	const entry: Entry = {
		type: "draft",
		agent: agent.name,
		atom,
		...(typeof meta.session === "string" ? { session: meta.session } : {}),
		...(typeof meta.subagent === "string" ? { subagent: meta.subagent } : {}),
		...(typeof meta.client === "string" ? { client: meta.client } : {}),
	};
	entries.push(entry);
	host.apply(entry);
}
