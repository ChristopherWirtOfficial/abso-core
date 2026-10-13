// Stand-ins for the Workers runtime in Node tests: a Durable Object's SQLite storage over node:sqlite, and the
// DigestStream the blob store hashes uploads with.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SqliteStorage } from "../src/engine-project.ts";

export function memoryStorage(): SqliteStorage & { db: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	let depth = 0;
	return {
		db,
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const statement = db.prepare(query);
				const args = bindings as never[];
				const rows = statement.columns().length > 0 ? statement.all(...args) : (statement.run(...args), []);
				// Workers hands BLOB columns back as ArrayBuffers.
				return {
					toArray: () =>
						rows.map((r) =>
							Object.fromEntries(
								Object.entries(r as Record<string, unknown>).map(([k, v]) => [
									k,
									v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v,
								]),
							),
						),
				};
			},
		},
		transactionSync<T>(fn: () => T): T {
			const name = `t${depth++}`;
			db.exec(`SAVEPOINT ${name}`);
			try {
				const value = fn();
				db.exec(`RELEASE ${name}`);
				return value;
			} catch (e) {
				db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
				throw e;
			} finally {
				depth--;
			}
		},
	};
}

/** Workers' crypto.DigestStream, for the blob store's streaming hash. */
export function installDigestStream(): void {
	const c = (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto;
	if (c.DigestStream) return;
	class DigestStream extends WritableStream<Uint8Array> {
		readonly digest: Promise<ArrayBuffer>;
		constructor(algorithm: string) {
			const hash = createHash(algorithm.replace("-", "").toLowerCase());
			let done!: (b: ArrayBuffer) => void;
			const digest = new Promise<ArrayBuffer>((ok) => {
				done = ok;
			});
			super({
				write: (chunk) => void hash.update(chunk),
				close: () => {
					const b = hash.digest();
					done(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
				},
			});
			this.digest = digest;
		}
	}
	c.DigestStream = DigestStream;
}

export function streamOf(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
}
