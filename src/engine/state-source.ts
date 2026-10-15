/**
 * Indexed graph storage. Values must be copied on write and read: a caller
 * mutating a returned list must not silently change persisted state. Hosts
 * provide transactions that roll back every write when the callback throws.
 * The namespace belongs to one graph and must not be shared by concurrent
 * Graph instances. Opening a graph does not scan its stored collections.
 */
export interface GraphStateStorage {
	read(collection: string, key: string): unknown;
	write(collection: string, key: string, value: unknown): void;
	remove(collection: string, key: string): void;
	entries(collection: string): Iterable<readonly [string, unknown]>;
	transaction<T>(body: () => T): T;
}

/**
 * Operation-local read cache with fixed payload and entry limits. Private numeric
 * pages, immutable scalars and serialized objects preserve the copy contract. Discard it after an outer host
 * rollback or any mutation made through another storage instance.
 */
type CachedValue = { bytes: number } & (
	| { kind: "scalar"; value: string | number | boolean | null | undefined }
	| { kind: "numbers"; value: readonly number[] }
	| { kind: "json"; json: string }
);

export class CachedStateStorage implements GraphStateStorage {
	readonly #source: GraphStateStorage;
	readonly #cache = new Map<string, CachedValue>();
	readonly #maxBytes: number;
	readonly #maxEntries: number;
	#bytes = 0;
	constructor(source: GraphStateStorage, maxBytes = 1_048_576, maxEntries = 4096) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0)
			throw new Error("invalid writer cache limits");
		this.#source = source;
		this.#maxBytes = maxBytes;
		this.#maxEntries = maxEntries;
	}
	get retainedBytes(): number {
		return this.#bytes;
	}
	get retainedEntries(): number {
		return this.#cache.size;
	}
	clear(): void {
		this.#cache.clear();
		this.#bytes = 0;
	}
	#drop(key: string): void {
		const previous = this.#cache.get(key);
		if (previous) {
			this.#cache.delete(key);
			this.#bytes -= previous.bytes;
		}
	}
	read(collection: string, key: string): unknown {
		const cacheKey = JSON.stringify([collection, key]);
		const hit = this.#cache.get(cacheKey);
		if (hit) {
			this.#cache.delete(cacheKey);
			this.#cache.set(cacheKey, hit);
			if (hit.kind === "scalar") return hit.value;
			if (hit.kind === "numbers") return hit.value.slice();
			return (JSON.parse(hit.json) as { value?: unknown }).value;
		}
		const value = this.#source.read(collection, key);
		const overhead = 2 * cacheKey.length + 160;
		let entry: CachedValue;
		if (
			value === undefined ||
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			entry = { kind: "scalar", value, bytes: overhead + (typeof value === "string" ? 2 * value.length : 16) };
		} else if (
			Array.isArray(value) &&
			value.length <= 256 &&
			Object.keys(value).length === value.length &&
			value.every(Number.isSafeInteger)
		) {
			// Store one private, bounded numeric page. Public reads still receive a
			// fresh copy; neither the source result nor a reader can mutate the cache.
			entry = { kind: "numbers", value: value.slice(), bytes: overhead + 32 + value.length * 8 };
		} else {
			const json = JSON.stringify({ value });
			entry = { kind: "json", json, bytes: overhead + 2 * json.length };
		}
		this.#remember(cacheKey, entry);
		return value;
	}
	#remember(cacheKey: string, entry: CachedValue): void {
		this.#drop(cacheKey);
		// Payload accounting is bounded, not a measurement of actual isolate heap.
		if (entry.bytes <= this.#maxBytes && this.#maxEntries > 0) {
			while (this.#bytes + entry.bytes > this.#maxBytes || this.#cache.size >= this.#maxEntries)
				this.#drop(this.#cache.keys().next().value!);
			this.#cache.set(cacheKey, entry);
			this.#bytes += entry.bytes;
		}
	}
	write(collection: string, key: string, value: unknown): void {
		const cacheKey = JSON.stringify([collection, key]);
		this.#drop(cacheKey);
		this.#source.write(collection, key, value);
		// Allocation counters are immutable scalars. Keep successful writes within
		// the existing cache budget instead of immediately reading them back.
		if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0))
			this.#remember(cacheKey, { kind: "scalar", value, bytes: 2 * cacheKey.length + 176 });
	}
	remove(collection: string, key: string): void {
		this.#drop(JSON.stringify([collection, key]));
		this.#source.remove(collection, key);
	}
	entries(collection: string): Iterable<readonly [string, unknown]> {
		return this.#source.entries(collection);
	}
	transaction<T>(body: () => T): T {
		try {
			return this.#source.transaction(body);
		} catch (error) {
			this.clear();
			throw error;
		}
	}
}

/**
 * Sets known to be closed under dependencies (abso Capacity): every atom's deps are in the set. A view or a project
 * given one skips proving it again, which read every atom and every dependency in the history.
 */
const closedSets = new WeakSet<object>();
export function markClosed<S extends ReadonlySet<unknown>>(set: S): S {
	closedSets.add(set);
	return set;
}
export function isClosedSet(set: unknown): boolean {
	return typeof set === "object" && set !== null && closedSets.has(set);
}

/** Immutable membership whose implementation does not retain its enumerated keys. */
export abstract class StableSet<T> implements ReadonlySet<T> {
	abstract has(value: T): boolean;
	abstract values(): SetIterator<T>;
	/** Only resident membership data; external storage is not charged as heap. */
	abstract readonly retainedBytes: number;
	get [Symbol.toStringTag](): string {
		return "Set";
	}
	get size(): number {
		let count = 0;
		for (const _ of this) count++;
		return count;
	}
	keys(): SetIterator<T> {
		return this.values();
	}
	*entries(): SetIterator<[T, T]> {
		for (const value of this) yield [value, value];
	}
	[Symbol.iterator](): SetIterator<T> {
		return this.values();
	}
	forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
		for (const value of this) callback.call(thisArg, value, value, this);
	}
}

/** Both operands must be immutable for the lifetime of this union. */
export class StableUnionSet<T> extends StableSet<T> {
	readonly #left: StableSet<T>;
	readonly #right: StableSet<T>;
	constructor(left: StableSet<T>, right: StableSet<T>) {
		super();
		this.#left = left;
		this.#right = right;
	}
	get retainedBytes(): number {
		return 32 + this.#left.retainedBytes + this.#right.retainedBytes;
	}
	get left(): StableSet<T> {
		return this.#left;
	}
	get right(): StableSet<T> {
		return this.#right;
	}
	has(value: T): boolean {
		return this.#left.has(value) || this.#right.has(value);
	}
	*values(): SetIterator<T> {
		yield* this.#left;
		for (const value of this.#right) if (!this.#left.has(value)) yield value;
	}
}

/** Immutable indexed subtraction retains neither operand's enumerated values. */
export class StableDifferenceSet<T> extends StableSet<T> {
	readonly left: StableSet<T>;
	readonly right: StableSet<T>;
	constructor(left: StableSet<T>, right: StableSet<T>) {
		super();
		this.left = left;
		this.right = right;
	}
	get retainedBytes(): number {
		return 32 + this.left.retainedBytes + this.right.retainedBytes;
	}
	has(value: T): boolean {
		return this.left.has(value) && !this.right.has(value);
	}
	*values(): SetIterator<T> {
		for (const value of this.left) if (!this.right.has(value)) yield value;
	}
}

/** Preserve indexed history; only the caller's operation-sized overlay is copied. */
export function unionOverlay<T>(base: ReadonlySet<T>, overlay: Iterable<T>): ReadonlySet<T> {
	return base instanceof StableSet
		? new StableUnionSet(base, new StableOverlaySet(overlay))
		: new Set([...base, ...overlay]);
}

/** Both indexed operands must be immutable for the lifetime of the result. */
export function differenceSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> {
	return left instanceof StableSet && right instanceof StableSet
		? new StableDifferenceSet(left, right)
		: new Set([...left].filter((value) => !right.has(value)));
}

/** An immutable snapshot for the operation's small overlay, not its history. */
export class StableOverlaySet<T> extends StableSet<T> {
	readonly #values: Set<T>;
	constructor(values: Iterable<T>) {
		super();
		this.#values = new Set(values);
	}
	get retainedBytes(): number {
		return 64 + this.#values.size * 32;
	}
	has(value: T): boolean {
		return this.#values.has(value);
	}
	values(): SetIterator<T> {
		return this.#values.values();
	}
}

const indexKey = (key: PropertyKey): key is string =>
	typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key));

/** Fixed-size numeric pages; callers retain no pages outside the bounded storage cache. */
export function storedNumbers(storage: GraphStateStorage, name: string) {
	const pageSize = 256;
	const meta = `${name}:meta`;
	const length = () => (storage.read(meta, "length") as number | undefined) ?? 0;
	// Older experimental writer indexes must be rebuilt from their canonical log.
	// Never interpret per-element rows as pages or silently lose existing history.
	const page = (index: number): number[] => {
		if (storage.read(meta, "format") !== 2)
			throw new Error(`writer numeric index ${name} requires canonical-log adoption`);
		const values = storage.read(`${name}:pages`, String(Math.floor(index / pageSize))) as number[] | undefined;
		if (!values) throw new Error(`missing writer numeric page in ${name}`);
		return values;
	};
	return {
		get length() {
			return length();
		},
		at(index: number): number {
			if (!Number.isSafeInteger(index) || index < 0 || index >= length())
				throw new Error(`writer numeric index out of bounds in ${name}`);
			const value = page(index)[index % pageSize];
			if (value === undefined) throw new Error(`incomplete writer numeric page in ${name}`);
			return value;
		},
		push(value: number): void {
			if (!Number.isSafeInteger(value)) throw new Error("writer numeric indexes require safe integers");
			const index = length();
			if (index > 0 && storage.read(meta, "format") !== 2)
				throw new Error(`writer numeric index ${name} requires canonical-log adoption`);
			const offset = index % pageSize;
			const values = offset === 0 ? [] : page(index);
			if (values.length !== offset) throw new Error(`invalid writer numeric page length in ${name}`);
			values.push(value);
			storage.write(`${name}:pages`, String(Math.floor(index / pageSize)), values);
			if (index === 0) storage.write(meta, "format", 2);
			storage.write(meta, "length", index + 1);
		},
		set(index: number, value: number): void {
			if (!Number.isSafeInteger(value)) throw new Error("writer numeric indexes require safe integers");
			if (!Number.isSafeInteger(index) || index < 0 || index >= length())
				throw new Error(`writer numeric index out of bounds in ${name}`);
			const values = page(index);
			if (index % pageSize >= values.length) throw new Error(`incomplete writer numeric page in ${name}`);
			values[index % pageSize] = value;
			storage.write(`${name}:pages`, String(Math.floor(index / pageSize)), values);
		},
	};
}

/** Array-shaped access without retaining its historical values in memory. */
export function storedArray<T>(
	storage: GraphStateStorage,
	name: string,
	decode?: (value: T) => T,
	encode?: (value: T, key: string) => unknown,
): T[] {
	const length = () => (storage.read(`${name}:meta`, "length") as number | undefined) ?? 0;
	const read = (key: string) => {
		const value = storage.read(name, key) as T;
		return value === undefined || !decode ? value : decode(value);
	};
	return new Proxy([] as T[], {
		get(target, key, receiver) {
			if (key === "length") return length();
			if (indexKey(key)) return Number(key) < length() ? read(key) : undefined;
			return Reflect.get(target, key, receiver);
		},
		set(_target, key, value) {
			if (key === "length") {
				if (value !== length()) throw new Error("stored graph arrays cannot be resized directly");
				return true;
			}
			if (!indexKey(key)) throw new Error("invalid stored graph array property");
			const index = Number(key);
			const size = length();
			if (index > size) throw new Error("stored graph arrays cannot contain gaps");
			storage.write(name, key, encode ? encode(value, key) : value);
			if (index === size) storage.write(`${name}:meta`, "length", size + 1);
			return true;
		},
		has(target, key) {
			return indexKey(key) ? Number(key) < length() : Reflect.has(target, key);
		},
		ownKeys() {
			return [...Array.from({ length: length() }, (_, index) => String(index)), "length"];
		},
		getOwnPropertyDescriptor(target, key) {
			if (indexKey(key) && Number(key) < length())
				return { configurable: true, enumerable: true, writable: true, value: read(key) };
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
}

export interface StateMap<K, V> {
	keys(): IterableIterator<K>;
	get(key: K): V | undefined;
	set(key: K, value: V): StateMap<K, V>;
	has(key: K): boolean;
	delete(key: K): boolean;
	values(): IterableIterator<V>;
}

/** Append-only per-key lists, retaining at most one fixed-size page per iterator. */
export function storedLists<V>(
	storage: GraphStateStorage,
	name: string,
	legacyKey = (key: string) => JSON.stringify(["string", key]),
) {
	const pageSize = 256;
	// The previous experimental layout stored one whole historical list per key.
	const length = (key: string) => {
		const stored = storage.read(`${name}:lengths`, key) as number | undefined;
		if (stored === undefined && storage.read(name, legacyKey(key)) !== undefined)
			throw new Error(`writer list index ${name} requires canonical-log adoption`);
		const count = stored ?? 0;
		if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid writer list count in ${name}`);
		return count;
	};
	const pageKey = (key: string, page: number) => JSON.stringify([key, page]);
	const page = (key: string, index: number): V[] => {
		const values = storage.read(`${name}:pages`, pageKey(key, index)) as V[] | undefined;
		if (!Array.isArray(values) || values.length < 1 || values.length > pageSize)
			throw new Error(`missing or invalid writer list page in ${name}`);
		return values;
	};
	return {
		length,
		*keys(): IterableIterator<string> {
			for (const entry of storage.entries(name)) {
				void entry;
				throw new Error(`writer list index ${name} requires canonical-log adoption`);
			}
			for (const [key] of storage.entries(`${name}:lengths`)) yield key;
		},
		*values(key: string): IterableIterator<V> {
			const count = length(key);
			for (let start = 0; start < count; start += pageSize) {
				const values = page(key, start / pageSize);
				if (values.length !== Math.min(pageSize, count - start))
					throw new Error(`incomplete writer list page in ${name}`);
				yield* values;
			}
		},
		last(key: string): V | undefined {
			const count = length(key);
			if (count === 0) return undefined;
			const values = page(key, Math.floor((count - 1) / pageSize));
			const expected = ((count - 1) % pageSize) + 1;
			if (values.length !== expected) throw new Error(`incomplete writer list page in ${name}`);
			return values[expected - 1];
		},
		append(key: string, value: V): void {
			const count = length(key);
			const offset = count % pageSize;
			const index = Math.floor(count / pageSize);
			const values = offset === 0 ? [] : page(key, index);
			if (values.length !== offset) throw new Error(`invalid writer list length in ${name}`);
			values.push(value);
			storage.write(`${name}:pages`, pageKey(key, index), values);
			storage.write(`${name}:lengths`, key, count + 1);
		},
		/** Append several values, writing each page they touch once. */
		appendAll(key: string, more: readonly V[]): void {
			if (more.length === 0) return;
			const count = length(key);
			let index = Math.floor(count / pageSize);
			let values = count % pageSize === 0 ? [] : page(key, index);
			if (values.length !== count % pageSize) throw new Error(`invalid writer list length in ${name}`);
			for (const value of more) {
				if (values.length === pageSize) {
					storage.write(`${name}:pages`, pageKey(key, index++), values);
					values = [];
				}
				values.push(value);
			}
			storage.write(`${name}:pages`, pageKey(key, index), values);
			storage.write(`${name}:lengths`, key, count + more.length);
		},
	};
}

/** Keys are tagged so numeric graph codes cannot collide with string keys. */
export function storedMap<K extends string | number, V>(storage: GraphStateStorage, name: string): StateMap<K, V> {
	const keyOf = (key: K) => JSON.stringify([typeof key, key]);
	const map: StateMap<K, V> = {
		*keys() {
			for (const [key] of storage.entries(name)) yield (JSON.parse(key) as [string, K])[1];
		},
		get: (key) => storage.read(name, keyOf(key)) as V | undefined,
		has: (key) => storage.read(name, keyOf(key)) !== undefined,
		set(key, value) {
			storage.write(name, keyOf(key), value);
			return map;
		},
		delete(key) {
			const existed = map.has(key);
			storage.remove(name, keyOf(key));
			return existed;
		},
		*values() {
			for (const [, value] of storage.entries(name)) yield value as V;
		},
	};
	return map;
}

/**
 * A Map-compatible persistent index. Iteration follows insertion order and
 * decodes one row at a time. Returned objects are copies, so mutations need
 * an explicit set. Hosts wrap a logical multi-index mutation in transaction.
 */
export class StoredMap<K extends string | number, V> extends Map<K, V> {
	readonly #storage: GraphStateStorage;
	readonly #name: string;
	readonly #encode: (value: V) => unknown;
	readonly #decode: (value: unknown) => V;
	constructor(
		storage: GraphStateStorage,
		name: string,
		codec?: { encode(value: V): unknown; decode(value: unknown): V },
	) {
		super();
		this.#storage = storage;
		this.#name = name;
		this.#encode = codec?.encode ?? ((value) => value);
		this.#decode = codec?.decode ?? ((value) => value as V);
	}
	#key(key: K): string {
		return JSON.stringify([typeof key, key]);
	}
	#row(key: K): { slot: number; value: unknown } | undefined {
		return this.#storage.read(this.#name, this.#key(key)) as { slot: number; value: unknown } | undefined;
	}
	override get size(): number {
		return (this.#storage.read(`${this.#name}:meta`, "size") as number | undefined) ?? 0;
	}
	override has(key: K): boolean {
		return this.#row(key) !== undefined;
	}
	override get(key: K): V | undefined {
		const row = this.#row(key);
		return row === undefined ? undefined : this.#decode(row.value);
	}
	override set(key: K, value: V): this {
		const row = this.#row(key);
		let slot = row?.slot;
		if (slot === undefined) {
			const keys = storedArray<K>(this.#storage, `${this.#name}:order`);
			slot = keys.length;
			keys.push(key);
			this.#storage.write(`${this.#name}:meta`, "size", this.size + 1);
		}
		this.#storage.write(this.#name, this.#key(key), { slot, value: this.#encode(value) });
		return this;
	}
	override delete(key: K): boolean {
		if (!this.has(key)) return false;
		this.#storage.remove(this.#name, this.#key(key));
		this.#storage.write(`${this.#name}:meta`, "size", this.size - 1);
		return true;
	}
	override clear(): void {
		for (const key of this.keys()) this.delete(key);
	}
	override *entries(): MapIterator<[K, V]> {
		const keys = storedArray<K>(this.#storage, `${this.#name}:order`);
		for (let slot = 0; slot < keys.length; slot++) {
			const key = keys[slot]!;
			const row = this.#row(key);
			if (row?.slot === slot) yield [key, this.#decode(row.value)];
		}
	}
	override *keys(): MapIterator<K> {
		const keys = storedArray<K>(this.#storage, `${this.#name}:order`);
		for (let slot = 0; slot < keys.length; slot++) {
			const key = keys[slot]!;
			if (this.#row(key)?.slot === slot) yield key;
		}
	}
	override *values(): MapIterator<V> {
		for (const [, value] of this.entries()) yield value;
	}
	override [Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}
	override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
	}
}

/** Persistent membership with streaming iteration and no in-memory key cache. */
export class StoredSet<K extends string | number> extends Set<K> {
	readonly #map: StoredMap<K, true>;
	constructor(storage: GraphStateStorage, name: string) {
		super();
		this.#map = new StoredMap(storage, name);
	}
	override get size(): number {
		return this.#map.size;
	}
	override has(key: K): boolean {
		return this.#map.has(key);
	}
	override add(key: K): this {
		this.#map.set(key, true);
		return this;
	}
	override delete(key: K): boolean {
		return this.#map.delete(key);
	}
	override clear(): void {
		this.#map.clear();
	}
	override *values(): SetIterator<K> {
		yield* this.#map.keys();
	}
	override keys(): SetIterator<K> {
		return this.values();
	}
	override *entries(): SetIterator<[K, K]> {
		for (const key of this.values()) yield [key, key];
	}
	override [Symbol.iterator](): SetIterator<K> {
		return this.values();
	}
	override forEach(callback: (value: K, key: K, set: Set<K>) => void, thisArg?: unknown): void {
		for (const key of this.values()) callback.call(thisArg, key, key, this);
	}
}

/** Read-only array access to individually stored values, without copying the list. */
/** How many values an atom's long list keeps to a row (readonlyPagedArray). */
export const LIST_PAGE = 256;

/** Write a list as readonlyPagedArray reads it: its values LIST_PAGE to a row, and its length. */
export function writePagedArray(storage: GraphStateStorage, name: string, values: readonly unknown[]): void {
	for (let start = 0; start < values.length; start += LIST_PAGE)
		storage.write(`${name}:pages`, String(start / LIST_PAGE), values.slice(start, start + LIST_PAGE));
	storage.write(`${name}:meta`, "length", values.length);
}

/**
 * A stored list read a page of LIST_PAGE values at a time (abso Capacity): an atom's long lists, which
 * readonlyStoredArray reads a row per value. Collisions read every key a draft's atoms write; a draft deleting a big
 * file has thousands, and that was a row each.
 */
export function readonlyPagedArray<T>(storage: GraphStateStorage, name: string): readonly T[] {
	const length = () => {
		const count = storage.read(`${name}:meta`, "length");
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw Error("invalid stored list length");
		return count as number;
	};
	length();
	let held = -1;
	let page: readonly unknown[] = [];
	const at = (index: number): T => {
		const p = Math.floor(index / LIST_PAGE);
		if (p !== held) {
			const raw = storage.read(`${name}:pages`, String(p));
			if (!Array.isArray(raw)) throw Error("missing stored list page");
			page = raw;
			held = p;
		}
		const value = page[index % LIST_PAGE];
		if (value === undefined) throw Error("missing stored list element");
		return (value && typeof value === "object" ? Object.freeze(value) : value) as T;
	};
	function* inOrder(): IterableIterator<T> {
		const count = length();
		for (let index = 0; index < count; index++) yield at(index);
	}
	return new Proxy([] as T[], {
		get(target, key, receiver) {
			if (key === "length") return length();
			if (key === Symbol.iterator || key === "values") return inOrder;
			if (indexKey(key)) return Number(key) >= length() ? undefined : at(Number(key));
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			return indexKey(key) ? Number(key) < length() : Reflect.has(target, key);
		},
		ownKeys() {
			return [...Array.from({ length: length() }, (_, index) => String(index)), "length"];
		},
		getOwnPropertyDescriptor(target, key) {
			if (indexKey(key) && Number(key) < length())
				return { configurable: true, enumerable: true, writable: false, value: at(Number(key)) };
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		set() {
			throw Error("stored lists are read-only");
		},
	});
}

export function readonlyStoredArray<T>(
	storage: GraphStateStorage,
	name: string,
	decode?: (value: unknown, index: number) => T,
): readonly T[] {
	const length = () => {
		const count = storage.read(`${name}:meta`, "length");
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw Error("invalid stored list length");
		return count as number;
	};
	length();
	const at = (index: number): T => {
		const raw = storage.read(name, String(index));
		const value = raw === undefined ? undefined : decode ? decode(raw, index) : (raw as T);
		if (value === undefined) throw Error("missing stored list element");
		return value && typeof value === "object" ? (Object.freeze(value) as T) : value;
	};
	// In order, with the length read once (abso Capacity): the array iterator reads it again before every element, a
	// second disk read per element of a list too long for the cache.
	function* inOrder(): IterableIterator<T> {
		const count = length();
		for (let index = 0; index < count; index++) yield at(index);
	}
	return new Proxy([] as T[], {
		get(target, key, receiver) {
			if (key === "length") return length();
			if (key === Symbol.iterator || key === "values") return inOrder;
			if (indexKey(key)) return Number(key) >= length() ? undefined : at(Number(key));
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			return indexKey(key) ? Number(key) < length() : Reflect.has(target, key);
		},
		ownKeys() {
			return [...Array.from({ length: length() }, (_, index) => String(index)), "length"];
		},
		getOwnPropertyDescriptor(target, key) {
			if (key === "length") return { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: length() };
			if (indexKey(key) && Number(key) < length()) {
				const raw = storage.read(name, key);
				const value = raw === undefined ? undefined : decode ? decode(raw, Number(key)) : (raw as T);
				if (value === undefined) throw Error("missing stored list element");
				return {
					configurable: true,
					enumerable: true,
					writable: false,
					value: value && typeof value === "object" ? Object.freeze(value) : value,
				};
			}
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		preventExtensions() {
			throw Error("stored list is read-only");
		},
		set() {
			throw Error("stored list is read-only");
		},
		deleteProperty() {
			throw Error("stored list is read-only");
		},
		defineProperty() {
			throw Error("stored list is read-only");
		},
	});
}
