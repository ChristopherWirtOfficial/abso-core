// Binary files' bytes (#27), content-addressed by SHA-256, kept in the
// project's own Durable Object SQLite: 1 MB rows, so a blob is never larger
// than a row allows, and hasBlob is a synchronous lookup the engine can call.
// Uploads stream in (a Durable Object RPC message stops at 32 MiB) and are
// hashed as they arrive; a blob whose bytes don't match its name isn't kept.
import { createHash } from "node:crypto";
import type { SqliteStorage } from "./engine-project.ts";

/** Per file. The push out to Artifacts holds a tree in memory, and a Durable Object has 128 MB. */
export const BLOB_MAX = 20 * 1024 * 1024;
const PART = 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const SCHEMA =
	"CREATE TABLE blobs (sha TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (sha, part))";

const normalizedSchema = (sql: string) => sql.replace(/\s+/g, " ").trim().toUpperCase();

export type PutBlob =
	| { status: 200; body: { sha256: string; size: number; stored: boolean } }
	| { status: 400 | 413; body: { error: string } };

export class BlobStore {
	private storage: SqliteStorage;

	constructor(storage: SqliteStorage) {
		this.storage = storage;
	}

	/** Reads must not create storage, including when a cold object has no blobs. */
	private hasSchema(): boolean {
		const rows = this.storage.sql.exec("SELECT type, sql FROM sqlite_master WHERE name = 'blobs'").toArray() as {
			type: string;
			sql: string | null;
		}[];
		if (rows.length === 0) return false;
		if (
			rows.length !== 1 ||
			rows[0]?.type !== "table" ||
			typeof rows[0].sql !== "string" ||
			normalizedSchema(rows[0].sql) !== normalizedSchema(SCHEMA)
		)
			throw new Error("unsupported blob storage schema");
		return true;
	}

	/** Only mutation paths may initialize the exact supported table. Never repair a mismatch. */
	private ensureSchema(): void {
		if (!this.hasSchema()) this.storage.sql.exec(SCHEMA);
	}

	/** Blobs in sha order after `after`, with their sizes (temporary uploads left out). */
	list(after: string, limit: number): { blobs: { sha: string; size: number }[]; next: string | null } {
		if (!this.hasSchema()) return { blobs: [], next: null };
		const rows = this.storage.sql
			.exec(
				"SELECT sha, SUM(LENGTH(data)) AS size FROM blobs WHERE sha > ? AND sha NOT LIKE 'tmp-%' GROUP BY sha ORDER BY sha LIMIT ?",
				after,
				limit + 1,
			)
			.toArray() as { sha: string; size: number }[];
		const more = rows.length > limit;
		const blobs = rows.slice(0, limit);
		return { blobs, next: more ? blobs.at(-1)!.sha : null };
	}

	has(sha: string): boolean {
		return (
			this.hasSchema() &&
			SHA.test(sha) &&
			this.storage.sql.exec("SELECT 1 FROM blobs WHERE sha = ? LIMIT 1", sha).toArray().length > 0
		);
	}

	/** Every byte, for the push out. Blobs are at most BLOB_MAX. */
	read(sha: string): Uint8Array | null {
		if (!this.hasSchema()) return null;
		const rows = this.storage.sql.exec("SELECT data FROM blobs WHERE sha = ? ORDER BY part", sha).toArray() as {
			data: ArrayBuffer;
		}[];
		if (rows.length === 0) return null;
		const out = new Uint8Array(rows.reduce((n, r) => n + r.data.byteLength, 0));
		let at = 0;
		for (const r of rows) {
			out.set(new Uint8Array(r.data), at);
			at += r.data.byteLength;
		}
		return out;
	}

	/** The bytes as a stream, one row at a time, or null. */
	stream(sha: string): ReadableStream<Uint8Array> | null {
		if (!this.has(sha)) return null;
		const parts = (
			this.storage.sql.exec("SELECT part FROM blobs WHERE sha = ? ORDER BY part", sha).toArray() as { part: number }[]
		).map((r) => r.part);
		let i = 0;
		return new ReadableStream<Uint8Array>({
			pull: (c) => {
				if (i >= parts.length) return c.close();
				const [row] = this.storage.sql
					.exec("SELECT data FROM blobs WHERE sha = ? AND part = ?", sha, parts[i++]!)
					.toArray() as { data: ArrayBuffer }[];
				c.enqueue(new Uint8Array(row!.data));
			},
		});
	}

	/**
	 * A whole file's text (#46), stored as UTF-8 under its SHA-256. Synchronous,
	 * so the engine can call it while it records.
	 */
	putText(text: string): string {
		const bytes = new TextEncoder().encode(text);
		const sha = createHash("sha256").update(bytes).digest("hex");
		if (!this.has(sha)) this.write(sha, bytes, 0);
		return sha;
	}

	/** A whole file's text back, or null. */
	textOf(sha: string): string | null {
		const bytes = this.read(sha);
		return bytes ? new TextDecoder().decode(bytes) : null;
	}

	/** Stores bytes already in memory (plain-git intake), under their own hash. */
	async putBytes(bytes: Uint8Array): Promise<string> {
		const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
		if (!this.has(sha)) this.write(sha, bytes, 0);
		return sha;
	}

	/** Streams an upload in, checking its size and that its SHA-256 is `sha`. */
	/** `max` lowers BLOB_MAX for this put (a capped project's file cap, abso issue 249). */
	async put(sha: string, body: ReadableStream<Uint8Array>, max: number = BLOB_MAX): Promise<PutBlob> {
		if (!SHA.test(sha)) return { status: 400, body: { error: "a blob's name is its SHA-256 in lowercase hex" } };
		if (this.has(sha)) {
			await body.cancel().catch(() => {});
			return { status: 200, body: { sha256: sha, size: this.size(sha), stored: false } };
		}
		const temp = `tmp-${crypto.randomUUID()}`;
		const digest = new crypto.DigestStream("SHA-256");
		const hashing = digest.getWriter();
		let size = 0;
		let part = 0;
		let pending: Uint8Array[] = [];
		let pendingSize = 0;
		const flush = () => {
			if (pendingSize === 0) return;
			part = this.write(temp, concat(pending, pendingSize), part);
			pending = [];
			pendingSize = 0;
		};
		try {
			for await (const chunk of body) {
				size += chunk.byteLength;
				if (size > max) {
					this.drop(temp);
					return { status: 413, body: { error: `blobs are at most ${max / 1024 / 1024} MB` } };
				}
				await hashing.write(chunk);
				pending.push(chunk);
				pendingSize += chunk.byteLength;
				if (pendingSize >= PART) flush();
			}
			flush();
			if (part === 0) part = this.write(temp, new Uint8Array(), 0); // an empty file is a blob too
			await hashing.close();
			const got = hex(await digest.digest);
			if (got !== sha) {
				this.drop(temp);
				return { status: 400, body: { error: `the bytes hash to ${got}, not ${sha}` } };
			}
			// Another upload of the same bytes may have finished meanwhile.
			if (this.has(sha)) this.drop(temp);
			else {
				this.ensureSchema();
				this.storage.sql.exec("UPDATE blobs SET sha = ? WHERE sha = ?", sha, temp);
			}
			return { status: 200, body: { sha256: sha, size, stored: true } };
		} catch (e) {
			this.drop(temp);
			throw e;
		}
	}

	/** Every blob's bytes together, referenced or not (a capped project's total, 249). Uploads in progress don't count. */
	total(): number {
		if (!this.hasSchema()) return 0;
		const [row] = this.storage.sql
			.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM blobs WHERE sha NOT LIKE 'tmp-%'")
			.toArray() as { n: number }[];
		return row?.n ?? 0;
	}

	/** A blob's size in bytes: 0 when the project doesn't hold it. */
	size(sha: string): number {
		if (!this.hasSchema()) return 0;
		const [row] = this.storage.sql
			.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM blobs WHERE sha = ?", sha)
			.toArray() as { n: number }[];
		return row?.n ?? 0;
	}

	/** Writes bytes as rows of at most PART from part `first` on; answers the next part. An empty blob is one empty row. */
	private write(sha: string, bytes: Uint8Array, first: number): number {
		this.ensureSchema();
		let part = first;
		for (let at = 0; at < bytes.byteLength || (at === 0 && part === 0); at += PART) {
			this.storage.sql.exec(
				"INSERT INTO blobs (sha, part, data) VALUES (?, ?, ?)",
				sha,
				part++,
				bytes.slice(at, at + PART),
			);
			if (bytes.byteLength === 0) break;
		}
		return part;
	}

	private drop(sha: string) {
		this.ensureSchema();
		this.storage.sql.exec("DELETE FROM blobs WHERE sha = ?", sha);
	}
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
