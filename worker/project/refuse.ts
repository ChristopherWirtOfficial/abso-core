// Answer a refused publish or land, and list those refusals. Writes go
// through RefuseHost; today the host is Project.

import { countRefusals } from "./project-helpers.ts";
import type { AgentState, Collision, Entry, Refusal, RefusalCounts } from "./project-types.ts";
import { SHARED, type Space } from "./spaces.ts";

/** What recording a refusal and listing them needs from a project. */
export interface RefuseHost {
	apply(entry: Entry): void;
	readonly refusals: readonly Refusal[];
}

/** Answer a refusal, and log it (an entry that changes nothing but the counts, and keeps a push's message). */
export function refuse(
	host: RefuseHost,
	agent: AgentState,
	space: Space,
	via: "publish" | "land",
	time: number,
	collisions: Collision[],
	entries: Entry[],
	message?: string,
): { ok: false; collisions: Collision[] } {
	const entry: Entry = {
		type: "refused",
		agent: agent.name,
		...(space.name !== SHARED ? { space: space.name } : {}),
		via,
		time,
		collisions: collisions.map((c) => ({
			kind: c.kind,
			file: c.file,
			...(c.name !== undefined ? { name: c.name } : {}),
		})),
		// A held push keeps its message: the settle that follows tells it as this side's reason.
		...(message ? { message } : {}),
	};
	entries.push(entry);
	host.apply(entry);
	return { ok: false, collisions };
}

/** Refused publishes and lands, newest first (`limit` defaults to 50), with counts over all of them. */
export function refusals(
	host: RefuseHost,
	options: { agent?: string; limit?: number } = {},
): { counts: RefusalCounts; refusals: Refusal[] } {
	const all = options.agent === undefined ? host.refusals : host.refusals.filter((r) => r.agent === options.agent);
	const limit = Number.isInteger(options.limit) && options.limit! > 0 ? options.limit! : 50;
	return { counts: countRefusals(all), refusals: all.slice(-limit).toReversed() };
}
