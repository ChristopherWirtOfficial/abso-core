// A named draft's state in one read. Reads go through DraftStateHost; today
// the host is Project.

import type { AtomId, Graph } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Collision } from "./project-types.ts";
import { last, SHARED, type Space, sharedBaseOf } from "./spaces.ts";

/** What a named draft's state read needs from a project. */
export interface DraftStateHost {
	needInit(): void;
	spaceNamed(name: string): Space;
	shared(): Space;
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, AgentState>;
	draft(agent: AgentState): AtomId[];
	checkClash(changes: readonly AtomId[]): void;
	landCollisions(space: Space, changes: AtomId[], pick: boolean): { collisions: Collision[] };
}

/**
 * A named draft's state in one read (#41, the Drafts page, D3 and D16): the shared version it builds on and
 * how far behind shared that is, its versions, when its first edit was, who works in it, and what landing it
 * now would collide with (the same check land makes, so nothing is written).
 */
export function draftState(
	host: DraftStateHost,
	name: string,
): {
	draft: string;
	base: number;
	shared: number;
	behind: number;
	versions: { version: number; agent: string; message: string; time: number; base: number }[];
	firstEdit: number | null;
	agents: { agent: string; unpublished: number }[];
	collisions: Collision[];
	clash?: string;
} {
	host.needInit();
	if (typeof name !== "string" || name === "") throw new ProjectError("bad-request", "draft needs ?name=<draft>");
	const space = host.spaceNamed(name);
	if (space.name === SHARED) throw new ProjectError("bad-request", "shared isn't a named draft");
	const shared = host.shared();
	const base = sharedBaseOf(space);
	const changes = [...space.own]
		.filter((id) => !shared.own.has(id) && !shared.droppedIn.has(id))
		.toSorted((p, q) => host.graph.atom(p).seq - host.graph.atom(q).seq);
	const agents = [...host.agents.values()]
		.filter((a) => a.space === space.name)
		.map((a) => ({ agent: a.name, unpublished: host.draft(a).length }))
		.toSorted((a, b) => (a.agent < b.agent ? -1 : 1));
	// The first edit: its earliest change, published or not.
	let firstEdit: number | null = null;
	const unpublished = [...host.agents.values()].filter((a) => a.space === space.name).flatMap((a) => host.draft(a));
	for (const id of [...changes, ...unpublished]) {
		const t = host.graph.atom(id).time;
		if (firstEdit === null || t < firstEdit) firstEdit = t;
	}
	let clash: string | undefined;
	try {
		host.checkClash(changes);
	} catch (e) {
		if (!(e instanceof ProjectError)) throw e;
		clash = e.message;
	}
	const collisions = changes.length > 0 ? host.landCollisions(space, changes, false).collisions : [];
	return {
		draft: space.name,
		base,
		shared: last(shared),
		behind: last(shared) - base,
		versions: space.versions
			.filter((p) => p.version > 0)
			.map((p) => ({
				version: p.version,
				agent: p.agent,
				message: p.message,
				time: p.time,
				base: p.sharedBase ?? 0,
			})),
		firstEdit,
		agents,
		collisions,
		...(clash !== undefined ? { clash } : {}),
	};
}
