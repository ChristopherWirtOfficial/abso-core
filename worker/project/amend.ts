// Correct the message of the agent's newest publish in its space. Writes go
// through AmendHost; today the host is Project.

import { ProjectError } from "./project-error.ts";
import type { AgentState, Entry } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What amending a publish message needs from a project. */
export interface AmendHost {
	agent(name: string, entries: Entry[]): AgentState;
	spaceOf(agent: AgentState): Space;
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
}

/**
 * Correct the message of the agent's newest publish in its space (#27).
 * Only the message changes: shared only grows, so a version's changes are
 * fixed by publishing again (or dropping it). The log keeps the original.
 */
export function amend(
	host: AmendHost,
	agentName: string,
	message: string,
	time: number,
): { version: number; draft: string | null; message: string; was: string } {
	if (typeof message !== "string" || message.trim() === "")
		throw new ProjectError("bad-request", "amend needs the new message");
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const space = host.spaceOf(agent);
	// Its newest version that published something (not a draft's bookkeeping versions).
	const mineAt = (v: number): boolean =>
		space.versions[v]!.agent === agent.name &&
		(space.versions[v]!.atoms.length > 0 || space.versions[v]!.dropped !== undefined);
	let version = last(space);
	while (version > 0 && !mineAt(version)) version--;
	const p = space.versions[version]!;
	if (version === 0) {
		host.flush(entries);
		throw new ProjectError(
			"bad-request",
			`${agent.name} hasn't pushed in ${space.name === SHARED ? "shared" : `draft ${space.name}`}, so there is nothing to amend`,
		);
	}
	const was = p.message;
	const entry: Entry = {
		type: "amend",
		agent: agent.name,
		...(space.name !== SHARED ? { space: space.name } : {}),
		version,
		message,
		time,
	};
	entries.push(entry);
	host.apply(entry);
	host.flush(entries);
	return { version, draft: space.name === SHARED ? null : space.name, message, was };
}
