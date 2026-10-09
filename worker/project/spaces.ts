// Version membership (#46, disk-first 1): which atoms are in which space at which version. Shared ('') and
// named drafts, their versions, what each version added and dropped, and the shared version a draft builds
// on. Project and the derived tables (tables/, issue 47) both keep it from the same entries, so the rules
// live here once.

import type { AtomId } from "../../src/engine/index.ts";
import type { Entry } from "./project.ts";

export const SHARED = "";

export interface Published {
	readonly version: number;
	readonly agent: string;
	/** The message now (an amend can correct it). */
	message: string;
	/** The message it was published with, once amended. */
	originalMessage?: string;
	readonly time: number;
	/** Everything this version added to its space (changes and tie). */
	readonly atoms: readonly AtomId[];
	/** For a named draft: the version of shared this version builds on. */
	readonly sharedBase?: number;
	/** For a drop: the atoms it took out, and the versions they came from. */
	readonly dropped?: readonly AtomId[];
	readonly droppedVersions?: readonly number[];
}

export /** Shared ('') or a named draft. */
interface Space {
	readonly name: string;
	readonly versions: Published[];
	/** Every atom published into this space (for shared, everything in it). */
	readonly own: Set<AtomId>;
	readonly publishedIn: Map<AtomId, number>;
	/** Atoms a drop took out, and the version of the drop. */
	readonly droppedIn: Map<AtomId, number>;
	readonly atCache: Map<number, ReadonlySet<AtomId>>;
	/** For a named draft, the log position of the entry that made it: the change its work belongs to (#44). */
	startedAt?: number;
}

export function newSpace(name: string): Space {
	return { name, versions: [], own: new Set(), publishedIn: new Map(), droppedIn: new Map(), atCache: new Map() };
}

export function addVersion(space: Space, version: Published): void {
	space.versions.push(version);
	for (const id of version.atoms) {
		space.own.add(id);
		space.publishedIn.set(id, version.version);
	}
	for (const id of version.dropped ?? []) {
		space.own.delete(id);
		space.droppedIn.set(id, version.version);
	}
}

export function last(space: Space): number {
	return space.versions.length - 1;
}

export function sharedBaseOf(space: Space): number {
	return space.versions[space.versions.length - 1]!.sharedBase ?? 0;
}

/** Every space, and each one's contents at any of its versions. */
export class Membership {
	readonly spaces = new Map<string, Space>([[SHARED, newSpace(SHARED)]]);

	get shared(): Space {
		return this.spaces.get(SHARED)!;
	}

	/** What an entry (at log position `at`) does to membership; other kinds change none. */
	apply(entry: Entry, at: number): void {
		switch (entry.type) {
			case "init":
				addVersion(this.shared, {
					version: 0,
					agent: "init",
					message: entry.atom.message,
					time: entry.time,
					atoms: [entry.atom.id],
				});
				break;
			case "publish": {
				const space = this.spaces.get(entry.space ?? SHARED)!;
				const atoms = [...entry.changes, entry.tie.id];
				addVersion(space, {
					version: entry.version,
					agent: entry.agent,
					message: entry.message,
					time: entry.time,
					atoms,
					...(space.name !== SHARED ? { sharedBase: sharedBaseOf(space) } : {}),
				});
				break;
			}
			case "drop":
				addVersion(this.shared, {
					version: entry.version,
					agent: entry.agent,
					message: entry.message,
					time: entry.time,
					atoms: [],
					dropped: entry.atoms,
					droppedVersions: entry.versions,
				});
				break;
			case "amend": {
				const p = this.spaces.get(entry.space ?? SHARED)!.versions[entry.version]!;
				p.originalMessage ??= p.message;
				p.message = entry.message;
				break;
			}
			case "space": {
				const space = newSpace(entry.name);
				space.startedAt = at;
				this.spaces.set(entry.name, space);
				addVersion(space, {
					version: 0,
					agent: entry.agent,
					message: `Start draft ${entry.name}`,
					time: entry.time,
					atoms: [],
					sharedBase: entry.sharedBase,
				});
				break;
			}
			case "space-sync": {
				const space = this.spaces.get(entry.space)!;
				addVersion(space, {
					version: entry.version,
					agent: entry.agent,
					message: `Move draft ${entry.space} onto shared version ${entry.sharedBase}`,
					time: entry.time,
					atoms: [],
					sharedBase: entry.sharedBase,
				});
				break;
			}
			case "land": {
				const atoms = [...entry.changes, entry.tie.id];
				addVersion(this.shared, {
					version: entry.version,
					agent: entry.agent,
					message: entry.message,
					time: entry.time,
					atoms,
				});
				if (entry.rebase) {
					const space = this.spaces.get(entry.space)!;
					addVersion(space, {
						version: last(space) + 1,
						agent: entry.agent,
						message: `Landed in shared version ${entry.version}`,
						time: entry.time,
						atoms: [],
						sharedBase: entry.version,
					});
				}
				break;
			}
		}
	}

	/**
	 * A space's contents at one of its versions. For shared's latest version this is `shared.own` itself, not a
	 * copy (it is read on every publish and sync, and copying it would cost a set per call): it changes when the
	 * next version is applied. A caller that keeps it across an apply copies it first.
	 */
	at(space: Space, version: number): ReadonlySet<AtomId> {
		if (space.name === SHARED && version === last(space)) return space.own;
		let set = space.atCache.get(version);
		if (!set) {
			const s = new Set<AtomId>();
			if (space.name !== SHARED) for (const id of this.at(this.shared, space.versions[version]!.sharedBase!)) s.add(id);
			for (let v = 0; v <= version; v++) {
				for (const id of space.versions[v]!.atoms) s.add(id);
				for (const id of space.versions[v]!.dropped ?? []) s.delete(id);
			}
			set = s;
			if (space.atCache.size > 16) space.atCache.clear();
			space.atCache.set(version, set);
		}
		return set;
	}
}
