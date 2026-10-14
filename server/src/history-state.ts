import type { GraphStateStorage } from "../../src/engine/state-source.ts";
import type { SqliteStorage } from "./engine-project.ts";
import { SqliteWriterState } from "./writer-host.ts";

/** Derived history for a freshly adopted writer namespace. The host supplies
 * canonical log positions and commits this state with the canonical transaction. */
export class SqliteHistoryState implements GraphStateStorage {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	readonly #current: SqliteWriterState;
	#revision: number;
	#sealedThrough = -1;
	static initialize(storage: SqliteStorage): void {
		SqliteWriterState.initialize(storage);
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS writer_history_keys (namespace TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(namespace, collection, key, revision))",
		);
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS writer_history_heads (namespace TEXT PRIMARY KEY, sealed INTEGER NOT NULL)",
		);
	}
	constructor(storage: SqliteStorage, namespace: string, revision = 0) {
		if (!namespace || namespace.length > 80) throw Error("invalid history namespace");
		if (!Number.isSafeInteger(revision) || revision < 0) throw Error("invalid history revision");
		this.#storage = storage;
		this.#namespace = namespace;
		this.#current = new SqliteWriterState(storage, namespace);
		this.#revision = revision;
	}
	beginRevision(revision: number): void {
		if (!Number.isSafeInteger(revision) || revision < this.#revision)
			throw Error("history revision must not go backwards");
		if (revision > this.#revision) this.seal();
		this.#revision = revision;
	}
	#sealed(): number {
		return (
			(
				this.#storage.sql
					.exec("SELECT sealed FROM writer_history_heads WHERE namespace = ?", this.#namespace)
					.toArray()[0] as { sealed: number } | undefined
			)?.sealed ?? -1
		);
	}
	seal(): void {
		this.#storage.sql.exec(
			"INSERT INTO writer_history_heads VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET sealed = MAX(sealed, excluded.sealed)",
			this.#namespace,
			this.#revision,
		);
		this.#sealedThrough = this.#revision;
	}
	#savedNamespace(revision: number): string {
		return `${this.#namespace}:history:${revision}`;
	}
	read(collection: string, key: string): unknown {
		return this.#current.read(collection, key);
	}
	entries(collection: string): Iterable<readonly [string, unknown]> {
		return this.#current.entries(collection);
	}
	write(collection: string, key: string, value: unknown): void {
		if (this.#revision <= Math.max(this.#sealedThrough, this.#sealed())) throw Error("historical revision is sealed");
		this.transaction(() => {
			this.#current.write(collection, key, value);
			const saved = this.#savedNamespace(this.#revision);
			this.#storage.sql.exec(
				"DELETE FROM writer_state WHERE namespace = ? AND collection = ? AND key = ?",
				saved,
				collection,
				key,
			);
			this.#storage.sql.exec(
				"INSERT INTO writer_state SELECT ?, collection, key, part, value FROM writer_state WHERE namespace = ? AND collection = ? AND key = ?",
				saved,
				this.#namespace,
				collection,
				key,
			);
			this.#storage.sql.exec(
				"INSERT OR REPLACE INTO writer_history_keys VALUES (?, ?, ?, ?, 0)",
				this.#namespace,
				collection,
				key,
				this.#revision,
			);
		});
	}
	remove(collection: string, key: string): void {
		if (this.#revision <= Math.max(this.#sealedThrough, this.#sealed())) throw Error("historical revision is sealed");
		this.transaction(() => {
			this.#current.remove(collection, key);
			new SqliteWriterState(this.#storage, this.#savedNamespace(this.#revision)).remove(collection, key);
			this.#storage.sql.exec(
				"INSERT OR REPLACE INTO writer_history_keys VALUES (?, ?, ?, ?, 1)",
				this.#namespace,
				collection,
				key,
				this.#revision,
			);
		});
	}
	transaction<T>(body: () => T): T {
		const revision = this.#revision;
		const sealed = this.#sealedThrough;
		try {
			return this.#storage.transactionSync(body);
		} catch (error) {
			this.#revision = revision;
			this.#sealedThrough = sealed;
			throw error;
		}
	}
	/** Read-only historical values, with bounded key pages and value decoding. */
	at(revision: number, assertAuthority: () => void = () => {}): GraphStateStorage {
		assertAuthority();
		if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.#revision)
			throw Error("history position outside authority");
		if (revision > this.#sealed()) throw Error("historical revision is not sealed");
		const storage = this.#storage,
			namespace = this.#namespace;
		const read = (collection: string, key: string): unknown => {
			assertAuthority();
			const row = storage.sql
				.exec(
					"SELECT revision, deleted FROM writer_history_keys WHERE namespace = ? AND collection = ? AND key = ? AND revision <= ? ORDER BY revision DESC LIMIT 1",
					namespace,
					collection,
					key,
					revision,
				)
				.toArray()[0] as { revision: number; deleted: number } | undefined;
			if (!row || row.deleted) return undefined;
			return new SqliteWriterState(storage, this.#savedNamespace(row.revision)).read(collection, key);
		};
		const refuse = (): never => {
			throw Error("historical state is read-only");
		};
		return {
			read,
			*entries(collection) {
				let after: string | undefined;
				for (;;) {
					assertAuthority();
					const rows = storage.sql
						.exec(
							`SELECT key FROM writer_history_keys WHERE namespace = ? AND collection = ? AND revision <= ? ${after === undefined ? "" : "AND key > ?"} GROUP BY key ORDER BY key LIMIT 64`,
							namespace,
							collection,
							revision,
							...(after === undefined ? [] : [after]),
						)
						.toArray() as { key: string }[];
					if (!rows.length) return;
					for (const row of rows) {
						const value = read(collection, row.key);
						// Stored undefined is a value; deletion is determined by the ledger.
						const latest = storage.sql
							.exec(
								"SELECT deleted FROM writer_history_keys WHERE namespace = ? AND collection = ? AND key = ? AND revision <= ? ORDER BY revision DESC LIMIT 1",
								namespace,
								collection,
								row.key,
								revision,
							)
							.toArray()[0] as { deleted: number };
						if (!latest.deleted) yield [row.key, value] as const;
					}
					after = rows.at(-1)!.key;
				}
			},
			write: refuse,
			remove: refuse,
			transaction: (body) => {
				assertAuthority();
				return storage.transactionSync(body);
			},
		};
	}
}
