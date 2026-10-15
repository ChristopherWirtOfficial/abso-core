// Version membership (#46, disk-first 1): which atoms are in which space at which version. Shared ('') and
// named drafts, their versions, what each version added and dropped, and the shared version a draft builds
// on. Project and the derived tables (tables/, issue 47) both keep it from the same entries, so the rules
// live here once.

import type { AtomId } from "../../src/engine/index.ts";
import {
	type GraphStateStorage,
	markClosed,
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
		};
	}
	return { name, versions: [], own: new Set(), publishedIn: new Map(), droppedIn: new Map() };
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

/**
 * Shared's closure on disk (abso Capacity): the atoms a version's views hold beyond what it published, because
 * something in it depends on them (a discarded atom a later publish still needs, abso issue 80). Kept per version as
 * events like membership's, so "is a in shared's closure at v" is two lookups, and no read proves closure again.
 * Indexed from the first version only: a writer adopted before this has none and is proved as before.
 */
const CLOSURE = 'closure:""';
const OWN = `membership:${JSON.stringify(SHARED)}`;

function extraEvent(storage: GraphStateStorage, atom: AtomId, version: number): MembershipEvent | undefined {
	return membershipEvent(storage, CLOSURE, atom, version);
}

/** Whether shared's closure changed at this version: its newest closure event is from it. */
export function closureChangedAt(storage: GraphStateStorage, version: number): boolean {
	const order = storedArray<MembershipEvent>(storage, `${CLOSURE}:events`);
	const length = order.length;
	return length > 0 && order[length - 1]!.version === version;
}

/** The newest shared version whose closure is indexed, or undefined when this writer has none. */
export function closureIndexed(storage: GraphStateStorage): number | undefined {
	return storage.read(`${CLOSURE}:meta`, "indexed") as number | undefined;
}

export interface ClosureGraph {
	atom(id: AtomId): { readonly deps: readonly AtomId[]; readonly seq: number };
	eachDependentOf(id: AtomId): Iterable<AtomId>;
}

/** Index shared's closure for every version applied since the last call. */
export function indexClosure(storage: GraphStateStorage, shared: Space, graph: ClosureGraph): void {
	const indexed = closureIndexed(storage);
	const newest = last(shared);
	if (indexed === undefined && newest > 0) return;
	for (let v = (indexed ?? -1) + 1; v <= newest; v++) indexClosureVersion(storage, shared.versions[v]!, graph);
	if (newest >= 0) storage.write(`${CLOSURE}:meta`, "indexed", newest);
}

function indexClosureVersion(storage: GraphStateStorage, version: Published, graph: ClosureGraph): void {
	const v = version.version;
	const own = (atom: AtomId) => membershipEvent(storage, OWN, atom, v)?.present ?? false;
	const extra = (atom: AtomId) => extraEvent(storage, atom, v)?.present ?? false;
	const present = (atom: AtomId) => own(atom) || extra(atom);
	const order = storedArray<MembershipEvent>(storage, `${CLOSURE}:events`);
	const set = (atom: AtomId, on: boolean) => {
		if (extra(atom) === on) return;
		const event = { atom, version: v, present: on, slot: order.length };
		storedArray<MembershipEvent>(storage, `${CLOSURE}:events:${atom}`).push(event);
		order.push(event);
	};
	for (const added of version.atoms) {
		const stack = [added];
		while (stack.length)
			for (const dep of graph.atom(stack.pop()!).deps)
				if (!present(dep)) {
					set(dep, true);
					stack.push(dep);
				}
	}
	// A dropped atom stays while something in the set depends on it, and so on down its deps: newest first, so an atom
	// is decided after everything that could depend on it.
	const candidates = new Map<AtomId, number>();
	for (const dropped of version.dropped ?? []) if (!own(dropped)) candidates.set(dropped, graph.atom(dropped).seq);
	while (candidates.size) {
		let atom: AtomId | undefined;
		let seq = -1;
		for (const [a, s] of candidates)
			if (s > seq) {
				atom = a;
				seq = s;
			}
		candidates.delete(atom!);
		if (own(atom!)) continue;
		let needed = false;
		for (const dependent of graph.eachDependentOf(atom!))
			if (present(dependent)) {
				needed = true;
				break;
			}
		set(atom!, needed);
		if (!needed)
			for (const dep of graph.atom(atom!).deps)
				if (!own(dep) && extra(dep) && !candidates.has(dep)) candidates.set(dep, graph.atom(dep).seq);
	}
}

/** Shared at a version with its closure: what it published, and what that depends on. Marked closed. */
class ClosedVersionSet extends StableSet<AtomId> {
	readonly retainedBytes = 96;
	readonly #storage: GraphStateStorage;
	readonly #version: number;
	readonly #own: StoredVersionSet;
	constructor(storage: GraphStateStorage, version: number) {
		super();
		this.#storage = storage;
		this.#version = version;
		this.#own = new StoredVersionSet(storage, OWN, version);
	}
	has(atom: AtomId): boolean {
		return this.#own.has(atom) || (extraEvent(this.#storage, atom, this.#version)?.present ?? false);
	}
	*values(): SetIterator<AtomId> {
		yield* this.#own;
		for (const event of storedArray<MembershipEvent>(this.#storage, `${CLOSURE}:events`)) {
			if (event.version > this.#version) break;
			if (!event.present || this.#own.has(event.atom)) continue;
			if (extraEvent(this.#storage, event.atom, this.#version)?.slot === event.slot) yield event.atom;
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

/**
 * How many built membership sets the in-memory path keeps, across every space (abso Capacity). Each named draft's set
 * is a whole copy of shared's at its base plus its own atoms, so a cache per space held one copy of shared per draft:
 * on prod project abso, 106 drafts kept 37 MB of them. One least-recently-used cache holds at most this many; a set
 * that fell out is built again when asked for, in milliseconds at that size. Measured on abso's prod export (81,855
 * entries): 96.6 MB after load before, 64.6 MB with 16 kept, 62.0 MB with 8; 16 keeps the load as fast as before.
 */
export const MEMBERSHIP_SETS_KEPT = 16;

/** A number per space object, so a space replaced under the same name (tables/build.ts) never gets the old one's sets. */
const spaceIds = new WeakMap<Space, number>();
let nextSpaceId = 0;
function spaceId(space: Space): number {
	let id = spaceIds.get(space);
	if (id === undefined) spaceIds.set(space, (id = nextSpaceId++));
	return id;
}

/** Every space, and each one's contents at any of its versions. */
export class Membership {
	readonly spaces: Map<string, Space>;
	readonly #storage?: GraphStateStorage;
	/** Built sets by space and version, oldest use first (MEMBERSHIP_SETS_KEPT). */
	readonly #sets = new Map<string, ReadonlySet<AtomId>>();
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
			const storage = this.#storage;
			const closed = (v: number) => (closureIndexed(storage) ?? -1) >= v;
			const sharedAt = (v: number): StableSet<AtomId> =>
				closed(v) ? markClosed(new ClosedVersionSet(storage, v)) : new StoredVersionSet(storage, OWN, v);
			if (space.name === SHARED) return sharedAt(version);
			const own = new StoredVersionSet(storage, `membership:${JSON.stringify(space.name)}`, version);
			// Named drafts add local atoms over an immutable shared base; drop
			// entries target shared, never a named draft's local membership.
			return new StableUnionSet(sharedAt(space.versions[version]!.sharedBase!), own);
		}
		if (space.name === SHARED && version === last(space)) return space.own;
		const key = `${spaceId(space)}:${version}`;
		const kept = this.#sets.get(key);
		if (kept) {
			this.#sets.delete(key);
			this.#sets.set(key, kept);
			return kept;
		}
		const s = new Set<AtomId>();
		if (space.name !== SHARED) for (const id of this.at(this.shared, space.versions[version]!.sharedBase!)) s.add(id);
		for (let v = 0; v <= version; v++) {
			for (const id of space.versions[v]!.atoms) s.add(id);
			for (const id of space.versions[v]!.dropped ?? []) s.delete(id);
		}
		this.#sets.set(key, s);
		if (this.#sets.size > MEMBERSHIP_SETS_KEPT) this.#sets.delete(this.#sets.keys().next().value!);
		return s;
	}

	/** How many built sets the in-memory cache holds now (for tests). */
	get setsKept(): number {
		return this.#sets.size;
	}
}
