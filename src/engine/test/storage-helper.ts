import { DatabaseSync } from "node:sqlite";
import type { GraphStateStorage } from "../state-source.ts";

export class SqlState implements GraphStateStorage {
	readonly db = new DatabaseSync(":memory:");
	reads = 0;
	writes = 0;
	scans = 0;
	failWrite = Infinity;
	constructor() {
		this.db.exec("CREATE TABLE state (collection TEXT, key TEXT, value TEXT, PRIMARY KEY(collection,key))");
	}
	read(collection: string, key: string): unknown {
		this.reads++;
		const row = this.db.prepare("SELECT value FROM state WHERE collection = ? AND key = ?").get(collection, key);
		return row ? JSON.parse(row.value as string).value : undefined;
	}
	write(collection: string, key: string, value: unknown): void {
		if (++this.writes === this.failWrite) throw new Error("injected storage failure");
		this.db.prepare("INSERT OR REPLACE INTO state VALUES (?, ?, ?)").run(collection, key, JSON.stringify({ value }));
	}
	remove(collection: string, key: string): void {
		this.db.prepare("DELETE FROM state WHERE collection = ? AND key = ?").run(collection, key);
	}
	*entries(collection: string): Iterable<readonly [string, unknown]> {
		this.scans++;
		for (const row of this.db
			.prepare("SELECT key, value FROM state WHERE collection = ? ORDER BY key")
			.iterate(collection))
			yield [row.key as string, JSON.parse(row.value as string).value];
	}
	transaction<T>(body: () => T): T {
		this.db.exec("SAVEPOINT graph_change");
		try {
			const value = body();
			this.db.exec("RELEASE graph_change");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK TO graph_change; RELEASE graph_change");
			throw error;
		}
	}
}
