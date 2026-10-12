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
 * Operation-local read cache with fixed payload and entry limits. Serialized
 * values preserve the storage copy contract. Discard it after an outer host
 * rollback or any mutation made through another storage instance.
 */
export class CachedStateStorage implements GraphStateStorage {
	readonly #source: GraphStateStorage;
	readonly #cache = new Map<string, { json: string; bytes: number }>();
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
			return (JSON.parse(hit.json) as { value?: unknown }).value;
		}
		const value = this.#source.read(collection, key);
		const json = JSON.stringify({ value });
		// Charge two bytes per UTF-16 unit and a conservative fixed entry cost.
		// This bounds retained payload; it is not an isolate heap measurement.
		const bytes = 2 * (json.length + cacheKey.length) + 128;
		if (bytes <= this.#maxBytes && this.#maxEntries > 0) {
			while (this.#bytes + bytes > this.#maxBytes || this.#cache.size >= this.#maxEntries)
				this.#drop(this.#cache.keys().next().value!);
			this.#cache.set(cacheKey, { json, bytes });
			this.#bytes += bytes;
		}
		return value;
	}
	write(collection: string, key: string, value: unknown): void {
		this.#drop(JSON.stringify([collection, key]));
		this.#source.write(collection, key, value);
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
	has(value: T): boolean {
		return this.#left.has(value) || this.#right.has(value);
	}
	*values(): SetIterator<T> {
		yield* this.#left;
		for (const value of this.#right) if (!this.#left.has(value)) yield value;
	}
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
export function storedArray<T>(storage: GraphStateStorage, name: string, decode?: (value: T) => T): T[] {
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
			storage.write(name, key, value);
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
export function storedLists<V>(storage: GraphStateStorage, name: string) {
	const pageSize = 256;
	// The previous experimental layout stored one whole historical list per key.
	const length = (key: string) => {
		const stored = storage.read(`${name}:lengths`, key) as number | undefined;
		if (stored === undefined && storage.read(name, JSON.stringify(["string", key])) !== undefined)
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
