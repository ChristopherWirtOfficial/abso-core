// Version membership (#46, disk-first 1): which atoms are in which space at which version. Shared ('') and
// named drafts, their versions, what each version added and dropped, and the shared version a draft builds
// on. Project and the derived tables (tables/, issue 47) both keep it from the same entries, so the rules
// live here once.

import type { AtomId } from "../../src/engine/index.ts";
import {
	type GraphStateStorage,
	StableSet,
	StableUnionSet,
	StoredMap,
	StoredSet,
	storedArray,
} from "../../src/engine/state-source.ts";
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
	/** Storage-backed spaces append the historical membership index here. */
	indexVersion?: (version: Published) => void;
	/** Version of the selected membership event, independent of later publishes. */
	membershipVersion?: (atom: AtomId, version: number) => number | undefined;
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

export function newSpace(name: string, storage?: GraphStateStorage): Space {
	if (storage) {
		const prefix = `membership:${JSON.stringify(name)}`;
		return {
			name,
			indexVersion: (version) => indexMembership(storage, prefix, version),
			membershipVersion: (atom, version) => membershipEvent(storage, prefix, atom, version)?.version,
			versions: storedArray(storage, `${prefix}:versions`),
			own: new StoredSet(storage, `${prefix}:own`),
			publishedIn: new StoredMap(storage, `${prefix}:published`),
			droppedIn: new StoredMap(storage, `${prefix}:dropped`),
			atCache: new Map(),
		};
	}
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
	space.indexVersion?.(version);
}

interface MembershipEvent {
	version: number;
	present: boolean;
	slot: number;
	atom: AtomId;
}

function membershipEvent(
	storage: GraphStateStorage,
	prefix: string,
	atom: AtomId,
	version: number,
): MembershipEvent | undefined {
	const events = storedArray<MembershipEvent>(storage, `${prefix}:events:${atom}`);
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if (events[mid]!.version <= version) lo = mid + 1;
		else hi = mid;
	}
	return lo === 0 ? undefined : events[lo - 1];
}

function indexMembership(storage: GraphStateStorage, prefix: string, version: Published): void {
	const order = storedArray<MembershipEvent>(storage, `${prefix}:events`);
	for (const [ids, present] of [
		[version.atoms, true],
		[version.dropped ?? [], false],
	] as const) {
		for (const atom of ids) {
			const previous = membershipEvent(storage, prefix, atom, version.version);
			if ((previous?.present ?? false) === present) continue;
			const event = { atom, version: version.version, present, slot: order.length };
			storedArray<MembershipEvent>(storage, `${prefix}:events:${atom}`).push(event);
			order.push(event);
		}
	}
}

/** Immutable historical shared membership; iteration reads one event at a time. */
class StoredVersionSet extends StableSet<AtomId> {
	readonly retainedBytes = 64;
	readonly #storage: GraphStateStorage;
	readonly #prefix: string;
	readonly #version: number;
	constructor(storage: GraphStateStorage, prefix: string, version: number) {
		super();
		this.#storage = storage;
		this.#prefix = prefix;
		this.#version = version;
	}
	get [Symbol.toStringTag](): string {
		return "Set";
	}
	has(atom: AtomId): boolean {
		return membershipEvent(this.#storage, this.#prefix, atom, this.#version)?.present ?? false;
	}
	get size(): number {
		let count = 0;
		for (const _ of this) count++;
		return count;
	}
	*values(): SetIterator<AtomId> {
		const events = storedArray<MembershipEvent>(this.#storage, `${this.#prefix}:events`);
		for (const event of events) {
			if (event.version > this.#version) break;
			if (!event.present) continue;
			const selected = membershipEvent(this.#storage, this.#prefix, event.atom, this.#version);
			if (selected?.slot === event.slot) yield event.atom;
		}
	}
	keys(): SetIterator<AtomId> {
		return this.values();
	}
	*entries(): SetIterator<[AtomId, AtomId]> {
		for (const atom of this) yield [atom, atom];
	}
	[Symbol.iterator](): SetIterator<AtomId> {
		return this.values();
	}
	forEach(callback: (value: AtomId, key: AtomId, set: ReadonlySet<AtomId>) => void, thisArg?: unknown): void {
		for (const atom of this) callback.call(thisArg, atom, atom, this);
	}
}

export function last(space: Space): number {
	return space.versions.length - 1;
}

/** Shared-version difference enumerates only versions newer than the base. */
export class SharedAdditions extends StableSet<AtomId> {
	readonly retainedBytes = 96;
	readonly endVersion: number;
	readonly space: Space;
	readonly baseVersion: number;
	readonly base: ReadonlySet<AtomId>;
	readonly current: ReadonlySet<AtomId>;
	constructor(space: Space, baseVersion: number, base: ReadonlySet<AtomId>, current: ReadonlySet<AtomId>) {
		super();
		if (space.name !== SHARED || !space.membershipVersion) throw Error("shared additions require indexed shared space");
		this.endVersion = last(space);
		this.space = space;
		this.baseVersion = baseVersion;
		this.base = base;
		this.current = current;
	}
	has(id: AtomId): boolean {
		return this.current.has(id) && !this.base.has(id);
	}
	*values(): SetIterator<AtomId> {
		for (let version = this.baseVersion + 1; version <= this.endVersion; version++) {
			for (const id of this.space.versions[version]!.atoms) {
				if (this.space.membershipVersion!(id, this.endVersion) === version && this.has(id)) yield id;
			}
		}
	}
}

export function sharedBaseOf(space: Space): number {
	return space.versions[space.versions.length - 1]!.sharedBase ?? 0;
}

/** Every space, and each one's contents at any of its versions. */
export class Membership {
	readonly spaces: Map<string, Space>;
	readonly #storage?: GraphStateStorage;
	constructor(storage?: GraphStateStorage) {
		this.#storage = storage;
		if (!storage) {
			this.spaces = new Map([[SHARED, newSpace(SHARED)]]);
			return;
		}
		this.spaces = new StoredMap(storage, "membership:spaces", {
			encode: (space) => ({ name: space.name, startedAt: space.startedAt }),
			decode: (value) => {
				const meta = value as { name: string; startedAt?: number };
				return {
					...newSpace(meta.name, storage),
					...(meta.startedAt === undefined ? {} : { startedAt: meta.startedAt }),
				};
			},
		});
		if (!this.spaces.has(SHARED)) storage.transaction(() => this.spaces.set(SHARED, newSpace(SHARED, storage)));
	}

	get shared(): Space {
		return this.spaces.get(SHARED)!;
	}

	/** What an entry (at log position `at`) does to membership; other kinds change none. */
	apply(entry: Entry, at: number): void {
		if (this.#storage) this.#storage.transaction(() => this.#apply(entry, at));
		else this.#apply(entry, at);
	}

	#apply(entry: Entry, at: number): void {
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
				const space = this.spaces.get(entry.space ?? SHARED)!;
				const p = space.versions[entry.version]!;
				p.originalMessage ??= p.message;
				p.message = entry.message;
				space.versions[entry.version] = p;
				break;
			}
			case "space": {
				const space = newSpace(entry.name, this.#storage);
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
		if (this.#storage) {
			const own = new StoredVersionSet(this.#storage, `membership:${JSON.stringify(space.name)}`, version);
			if (space.name === SHARED) return own;
			// Named drafts add local atoms over an immutable shared base; drop
			// entries target shared, never a named draft's local membership.
			const base = new StoredVersionSet(
				this.#storage,
				`membership:${JSON.stringify(SHARED)}`,
				space.versions[version]!.sharedBase!,
			);
			return new StableUnionSet(base, own);
		}
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
