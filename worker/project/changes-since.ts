// The files whose text in the agent's view differs from before, and its open
// collisions. Reads go through ChangesSinceHost; today the host is Project.

import type { AtomId, ReadView } from "../../src/engine/index.ts";
import type { Pair } from "./collisions.ts";
import { sortKeys } from "./project-helpers.ts";
import type { AgentState, Blobs, Collision, Files, Modes, SyncAnswer } from "./project-types.ts";
import { modeChange } from "./view-changes.ts";

/** What a changes-since read needs from a project. */
export interface ChangesSinceHost {
	agentView(agent: AgentState): ReadView;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
	openPairs(agent: AgentState): Pair[];
	collision(agent: AgentState, pair: Pair): Collision;
	duplicates(agent: AgentState): Collision[];
	markedCollisions(agent: AgentState): Collision[];
}

/** The files whose text in the agent's view differs from `before`, and its open collisions. */
export function changesSince(host: ChangesSinceHost, agent: AgentState, before: ReadView): SyncAnswer {
	const after = host.agentView(agent);
	// Only files that an atom in one view but not the other touches can differ.
	const touched = new Set<string>();
	for (const [a, b] of [
		[before.set, after.set],
		[after.set, before.set],
	] as const) {
		for (const file of host.touchedFiles(
			[...a].filter((id) => !b.has(id)),
			[before, after],
		))
			touched.add(file);
	}
	const files: Files = {};
	const modes: Modes = {};
	const blobs: Blobs = {};
	for (const path of touched) {
		const text = after.hasFile(path) ? after.text(path) : null;
		const blobBefore = before.attrs(path).blob;
		const blobAfter = after.attrs(path).blob;
		if (blobAfter !== blobBefore) blobs[path] = blobAfter;
		// A binary file's bytes come by blob; a file that stops being binary always comes by text (or null).
		if (blobAfter === null && (blobBefore !== null || text !== (before.hasFile(path) ? before.text(path) : null)))
			files[path] = text;
		const m = modeChange(before, after, path);
		if (m) modes[path] = m.after;
	}
	const collisions = [
		...host.openPairs(agent).map((p) => host.collision(agent, p)),
		...host.duplicates(agent),
		...host.markedCollisions(agent),
	];
	return {
		version: agent.base,
		files: sortKeys(files),
		collisions,
		...(Object.keys(modes).length > 0 ? { modes: sortKeys(modes) } : {}),
		...(Object.keys(blobs).length > 0 ? { blobs: sortKeys(blobs) } : {}),
	};
}
