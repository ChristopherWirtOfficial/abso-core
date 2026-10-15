// Where an atom was published. Reads go through PublishOfHost; today the host
// is Project.

import type { AtomId } from "../../src/engine/index.ts";
import { SHARED, type Space } from "./spaces.ts";

/** What a publish-of read needs from a project. */
export interface PublishOfHost {
	shared(): Space;
	readonly spaces: ReadonlyMap<string, Space>;
}

/**
 * Where an atom was published: shared if it's there, else the named draft
 * that has it (by name), else undefined (it's only in a draft so far).
 */
export function publishOf(
	host: PublishOfHost,
	atom: AtomId,
): { draft: string | null; version: number; agent: string; message: string; time: number } | undefined {
	// Shared first, and the named drafts only when it isn't there: listing them reads each one's space.
	const spaces = function* (): Generator<Space> {
		yield host.shared();
		yield* [...host.spaces.values()].filter((s) => s.name !== SHARED).toSorted((a, b) => (a.name < b.name ? -1 : 1));
	};
	for (const space of spaces()) {
		const version = space.publishedIn.get(atom);
		if (version === undefined) continue;
		const p = space.versions[version]!;
		return {
			draft: space.name === SHARED ? null : space.name,
			version,
			agent: p.agent,
			message: p.message,
			time: p.time,
		};
	}
	return undefined;
}
