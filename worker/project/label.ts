// Put a label on a version of shared, or take it off. Writes go through
// LabelHost; today the host is Project.

import { ProjectError } from "./project-error.ts";
import { NAME } from "./project-helpers.ts";
import type { AgentState, Entry } from "./project-types.ts";

/** What labeling a version of shared needs from a project. */
export interface LabelHost {
	agent(name: string, entries: Entry[]): AgentState;
	version(): number;
	readonly labels: ReadonlyMap<string, readonly number[]>;
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
}

/**
 * Put a label on a version of shared (the newest by default), or take it
 * off with `remove`. A label can mark many versions ("passed-ci"); a folder
 * follows the newest with `sync {label}`.
 */
export function label(
	host: LabelHost,
	agentName: string,
	name: string,
	version: number | undefined,
	time: number,
	options: { remove?: boolean } = {},
): { name: string; version: number; versions: number[] } {
	if (typeof name !== "string" || !NAME.test(name))
		throw new ProjectError(
			"bad-request",
			`bad label ${JSON.stringify(name)}: letters, digits, '.', '_' and '-', up to 64`,
		);
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const v = version ?? host.version();
	if (!Number.isInteger(v) || v < 0 || v > host.version())
		throw new ProjectError("bad-request", `there is no version ${String(v)} of shared`);
	const has = host.labels.get(name)?.includes(v) ?? false;
	if (has !== (options.remove === true)) {
		host.flush(entries);
		return { name, version: v, versions: [...(host.labels.get(name) ?? [])].toReversed() };
	}
	const entry: Entry = {
		type: "label",
		agent: agent.name,
		name,
		version: v,
		time,
		...(options.remove ? { remove: true } : {}),
	};
	entries.push(entry);
	host.apply(entry);
	host.flush(entries);
	return { name, version: v, versions: [...(host.labels.get(name) ?? [])].toReversed() };
}
