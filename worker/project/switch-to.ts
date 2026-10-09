// Move an agent to a named draft, or back to shared. Writes go through
// SwitchHost; today the host is Project.

import { type AtomId, type Graph, View } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import { checkDraftName } from "./project-helpers.ts";
import type { AgentState, Entry, SwitchAnswer, SyncAnswer } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What switching an agent's draft needs from a project. */
export interface SwitchHost {
	agent(name: string, entries: Entry[]): AgentState;
	flush(entries: Entry[]): void;
	readonly spaces: ReadonlyMap<string, Space>;
	agentView(agent: AgentState): View;
	readonly graph: Graph;
	version(): number;
	apply(entry: Entry): void;
	draft(agent: AgentState): readonly AtomId[];
	setOf(space: Space): ReadonlySet<AtomId>;
	changesSince(agent: AgentState, before: View): SyncAnswer;
}

/**
 * Move the agent to a named draft, or back to shared with null. Its
 * unpublished changes stay parked on the server in the space it leaves,
 * and what it parked in the space it moves to comes back. Nothing is lost
 * and nothing has to be published or stashed first. A new named draft
 * starts on shared's newest version; with `carry`, the agent's current
 * unpublished changes move into it instead of being parked. Answers like a
 * sync: the files that change in its folder.
 */
export function switchTo(
	host: SwitchHost,
	agentName: string,
	draftName: string | null,
	time: number,
	options: { carry?: boolean } = {},
): SwitchAnswer {
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const target = draftName === null ? SHARED : checkDraftName(draftName);
	const carry = options.carry === true;
	const name = target === SHARED ? null : target;
	if (target === agent.space && !carry) {
		host.flush(entries);
		return { version: agent.base, files: {}, collisions: [], draft: name };
	}
	if (carry && host.spaces.has(target)) {
		throw new ProjectError(
			"bad-request",
			`carrying changes starts a new named draft, and ${name ?? "shared"} already exists`,
		);
	}
	const before = agent.synced ? host.agentView(agent) : new View(host.graph, []);
	if (!host.spaces.has(target)) {
		entries.push({ type: "space", name: target, agent: agent.name, time, sharedBase: host.version() });
		host.apply(entries[entries.length - 1]!);
	}
	const space = host.spaces.get(target)!;
	if (carry) {
		const draft = host.draft(agent);
		const into = new Set([...host.setOf(space), ...draft]);
		for (const id of draft) {
			if (host.graph.atom(id).deps.some((d) => !into.has(d))) {
				throw new ProjectError(
					"bad-request",
					`your unpublished changes build on changes that shared doesn't have yet (they're in draft ${agent.space}); publish them there first, or switch without carrying`,
				);
			}
		}
	}
	entries.push({ type: "switch", agent: agent.name, space: target, version: last(space), carry });
	host.apply(entries[entries.length - 1]!);
	const answer = host.changesSince(agent, before);
	host.flush(entries);
	return { ...answer, version: agent.base, draft: name };
}
