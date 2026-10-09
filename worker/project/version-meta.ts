// Who made a version, how new it is, and whether that version exists. Reads
// go through VersionMetaHost; today the host is Project.

import { ProjectError } from "./project-error.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What version metadata reads need from a project. */
export interface VersionMetaHost {
	needInit(): void;
	spaceNamed(name: string | null): Space;
}

/** There is no such version of this space. */
export function checkVersion(space: Space, version: number): void {
	if (!Number.isInteger(version) || version < 0 || version > last(space)) {
		throw new ProjectError(
			"bad-request",
			`there is no version ${String(version)}${space.name === SHARED ? "" : ` of draft ${space.name}`}`,
		);
	}
}

/** The newest version of shared, or of a named draft. */
export function lastVersion(host: VersionMetaHost, draft: string | null = null): number {
	host.needInit();
	return last(host.spaceNamed(draft));
}

/**
 * Who made a version of shared or a named draft, why and when, and a draft's
 * shared base (abso issue 80).
 */
export function versionMeta(
	host: VersionMetaHost,
	version: number,
	draft: string | null = null,
): { agent: string; message: string; time: number; sharedBase?: number } {
	host.needInit();
	const space = host.spaceNamed(draft);
	checkVersion(space, version);
	const p = space.versions[version]!;
	return {
		agent: p.agent,
		message: p.message,
		time: p.time,
		...(p.sharedBase !== undefined ? { sharedBase: p.sharedBase } : {}),
	};
}
