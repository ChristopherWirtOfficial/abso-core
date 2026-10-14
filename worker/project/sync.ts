import { View } from "../../src/engine/index.ts";
// Move the agent's base to its space's newest version. Writes go through
// SyncHost; today the host is Project.

import type { AtomId, Graph, ReadView } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Entry, MergedLine, SyncAnswer } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What a sync needs from a project. */
export interface SyncHost {
	readonly graph: Graph;
	readonly labels: ReadonlyMap<string, readonly number[]>;
	agent(name: string, entries: Entry[]): AgentState;
	spaceOf(agent: AgentState): Space;
	agentView(agent: AgentState): ReadView;
	captureAgentView?(agent: AgentState): () => ReadView;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	draft(agent: AgentState): AtomId[];
	strandedFiles(draft: readonly AtomId[], set: ReadonlySet<AtomId>): string[];
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
	mergeIdentical(
		agent: AgentState,
		before: ReadView,
		oldBase: ReadonlySet<AtomId>,
		oldVersion: number,
		time: number,
		entries: Entry[],
	): MergedLine[];
	changesSince(agent: AgentState, before: ReadView): SyncAnswer;
}

/**
 * Move the agent's base to its space's newest version. Returns every file
 * whose text in its view changes (null when it's gone), and the collisions
 * it now has to settle. A first sync returns every file (that's how a
 * folder joins).
 */
export function sync(host: SyncHost, agentName: string, options: { label?: string; full?: boolean } = {}): SyncAnswer {
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const space = host.spaceOf(agent);
	let target = last(space);
	if (options.label !== undefined) {
		// Follow a label (#10): the newest version of shared that carries it.
		if (space.name !== SHARED)
			throw new ProjectError("bad-request", "labels mark versions of shared; switch to shared to follow one");
		const versions = host.labels.get(options.label);
		if (!versions)
			throw new ProjectError("bad-request", `no version of shared has the label ${JSON.stringify(options.label)}`);
		target = versions[versions.length - 1]!;
	}
	const reopenBefore = agent.synced ? host.captureAgentView?.(agent) : undefined;
	const before = agent.synced ? host.agentView(agent) : new View(host.graph, []);
	const set = host.at(space, target);
	const stranded = host.strandedFiles(host.draft(agent), set);
	if (stranded.length > 0) {
		host.flush(entries);
		throw new ProjectError(
			"conflict",
			target === last(space)
				? `your unpushed changes to ${stranded.join(", ")} build on lines a drop took out of shared; ` +
						`restore those files (abso restore ${stranded.join(" ")}) and pull again`
				: `your unpushed changes to ${stranded.join(", ")} build on lines version ${target} doesn't have yet; ` +
						`push or restore them before following label ${options.label}`,
		);
	}
	// Moving back to a labeled version: the agent's own newer published work must not build on what that version lacks.
	const mineAfter = agent.mine.filter((id) => !set.has(id));
	const lacking = host.strandedFiles(mineAfter, set);
	if (lacking.length > 0) {
		host.flush(entries);
		throw new ProjectError(
			"conflict",
			`your pushed changes to ${lacking.join(", ")} build on versions after ${target}, so you can't move back to it`,
		);
	}
	const oldBase = host.at(space, agent.base);
	const oldVersion = agent.base;
	entries.push({ type: "sync", agent: agent.name, version: target });
	host.apply(entries[entries.length - 1]!);
	// News about versions the agent has now synced past is moot: the sync answer lists what's still open (#37).
	if (agent.news.some((t) => !t.startsWith("Announcement from "))) {
		const heard: Entry = { type: "heard", agent: agent.name, stale: true };
		entries.push(heard);
		host.apply(heard);
	}
	const merged = host.mergeIdentical(agent, before, oldBase, oldVersion, Date.now(), entries);
	// full (#37, a partial join): every file in the view, as for a first sync, whatever the folder had.
	const answer = host.changesSince(
		agent,
		options.full ? new View(host.graph, []) : reopenBefore ? reopenBefore() : before,
	);
	host.flush(entries);
	return merged.length > 0 ? { ...answer, merged } : answer;
}
