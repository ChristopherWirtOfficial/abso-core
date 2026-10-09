// An agent's unpublished changes, file by file. They read through DraftDiffHost; today the host is the project
// in memory.

import type { AtomId, View } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type { DiffAnswer } from "./project-types.ts";
import { SHARED } from "./spaces.ts";
import { changesBetween } from "./view-changes.ts";

interface Agent {
	readonly space: string;
	readonly base: number;
}

/** What the draft diff reads need from a project. */
export interface DraftDiffHost {
	readonly agents: ReadonlyMap<string, Agent>;
	needInit(): void;
	draft(agent: Agent): AtomId[];
	agentView(agent: Agent): View;
	view(set: ReadonlySet<AtomId>): View;
	touchedFiles(ids: Iterable<AtomId>, views: readonly View[]): Set<string>;
}

/** An agent's draft diff for a reader (#41, the website): never creates the agent, never writes. */
export function diffOf(host: DraftDiffHost, agentName: string): DiffAnswer {
	host.needInit();
	const agent = host.agents.get(agentName);
	if (!agent) throw new ProjectError("not-found", `there is no agent ${JSON.stringify(agentName)}`);
	return diffOfAgent(host, agent);
}

/** What the agent's unpublished changes do, file by file: its space at its base, then its view. */
export function diffOfAgent(host: DraftDiffHost, agent: Agent): DiffAnswer {
	const draft = host.draft(agent);
	const after = host.agentView(agent);
	const without = new Set(draft);
	const before = host.view(new Set([...after.set].filter((id) => !without.has(id))));
	const files = host.touchedFiles(draft, [before, after]);
	return {
		draft: agent.space === SHARED ? null : agent.space,
		base: agent.base,
		files: changesBetween(before, after, files),
	};
}
