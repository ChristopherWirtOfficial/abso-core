import type { GraphStateStorage } from "../state-source.ts";

type OverlayRow = { collection: string; key: string; present: boolean; value?: unknown };

/** Disk-backed temporary pages over immutable committed projection pages. */
export class ProjectionOverlayStorage implements GraphStateStorage {
	readonly #base: GraphStateStorage;
	readonly #collection: string;
	readonly #clearCollection?: (collection: string) => void;
	#open = true;
	constructor(base: GraphStateStorage, namespace: string, clearCollection?: (collection: string) => void) {
		if (!namespace) throw Error("missing projection overlay namespace");
		this.#base = base;
		this.#collection = `projection:temporary:${namespace}`;
		this.#clearCollection = clearCollection;
		for (const _ of base.entries(this.#collection)) throw Error("projection overlay namespace is occupied");
	}
	#check(): void {
		if (!this.#open) throw Error("closed projection overlay");
	}
	#key(collection: string, key: string): string {
		return JSON.stringify([collection, key]);
	}
	read(collection: string, key: string): unknown {
		this.#check();
		const row = this.#base.read(this.#collection, this.#key(collection, key)) as OverlayRow | undefined;
		return row ? (row.present ? row.value : undefined) : this.#base.read(collection, key);
	}
	write(collection: string, key: string, value: unknown): void {
		this.#check();
		this.#base.write(this.#collection, this.#key(collection, key), { collection, key, present: true, value });
	}
	remove(collection: string, key: string): void {
		this.#check();
		this.#base.write(this.#collection, this.#key(collection, key), { collection, key, present: false });
	}
	*entries(collection: string): Iterable<readonly [string, unknown]> {
		this.#check();
		for (const [key, value] of this.#rows(collection)) {
			this.#check();
			if (!this.#base.read(this.#collection, this.#key(collection, key))) yield [key, value];
		}
		for (const [, value] of this.#rows(this.#collection)) {
			this.#check();
			const row = value as OverlayRow;
			if (row.collection === collection && row.present) yield [row.key, row.value];
		}
		this.#check();
	}
	*#rows(collection: string): Iterable<readonly [string, unknown]> {
		this.#check();
		const iterator = this.#base.entries(collection)[Symbol.iterator]();
		while (true) {
			this.#check();
			const next = iterator.next();
			this.#check();
			if (next.done) return;
			yield next.value;
		}
	}
	transaction<T>(body: () => T): T {
		this.#check();
		return this.#base.transaction(body);
	}
	/** Invoke before the owning outer transaction commits; failed cleanup must abort it. */
	close(): void {
		if (!this.#open) return;
		this.#base.transaction(() => {
			if (this.#clearCollection) {
				const result: unknown = this.#clearCollection(this.#collection);
				if (result && typeof result === "object" && "then" in result)
					throw Error("overlay cleanup must be synchronous");
			} else {
				for (const [key] of this.#base.entries(this.#collection)) this.#base.remove(this.#collection, key);
			}
		});
		this.#open = false;
	}
}
