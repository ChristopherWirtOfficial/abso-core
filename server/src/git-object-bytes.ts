import { createHash } from "node:crypto";
import type { SqliteStorage } from "./engine-project.ts";
import type { GitByteRanges } from "./git-delta-stream.ts";

export type StoredGitBytes = GitByteRanges & {
	id: string;
	oid: string;
	type: string;
};

/** Intake-local object bytes; callers own this store's lifetime. */
export class GitObjectBytes {
	readonly scope = crypto.randomUUID();
	private closed = false;
	private readonly storage: SqliteStorage;
	private readonly maxDecodedBytes: number;
	constructor(storage: SqliteStorage, maxDecodedBytes = Number.MAX_SAFE_INTEGER) {
		if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) throw Error("invalid decoded byte limit");
		this.storage = storage;
		this.maxDecodedBytes = maxDecodedBytes;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS git_object_bytes (scope TEXT, id TEXT, part INTEGER, data BLOB NOT NULL, PRIMARY KEY(scope,id,part))",
		);
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS git_object_meta (scope TEXT, id TEXT, type TEXT, bytes INTEGER, oid TEXT, PRIMARY KEY(scope,id))",
		);
		storage.sql.exec("CREATE TABLE IF NOT EXISTS git_object_budget (scope TEXT PRIMARY KEY, decoded INTEGER NOT NULL)");
		storage.sql.exec("INSERT INTO git_object_budget VALUES (?, 0)", this.scope);
	}
	private active(): void {
		if (this.closed) throw Error("Git object store is closed");
	}
	put(type: string, produce: (write: (bytes: Uint8Array) => void) => void, maxBytes: number): StoredGitBytes {
		this.active();
		if (!["blob", "tree", "commit", "tag"].includes(type) || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
			throw Error("invalid Git object limits or type");
		const id = crypto.randomUUID();
		this.storage.transactionSync(() => {
			const budget = this.storage.sql
				.exec("SELECT decoded FROM git_object_budget WHERE scope = ?", this.scope)
				.toArray() as { decoded: number }[];
			if (budget.length !== 1) throw Error("missing Git decoded budget");
			const remaining = this.maxDecodedBytes - budget[0]!.decoded;
			let length = 0,
				part = 0,
				used = 0;
			const pending = new Uint8Array(65536);
			const flush = () => {
				this.storage.sql.exec(
					"INSERT INTO git_object_bytes VALUES (?, ?, ?, ?)",
					this.scope,
					id,
					part++,
					pending.slice(0, used),
				);
				used = 0;
			};
			produce((bytes) => {
				if (length + bytes.length > maxBytes) throw Error("Git object exceeds byte limit");
				if (length + bytes.length > remaining) throw Error("Git pack exceeds total decoded byte limit");
				length += bytes.length;
				for (let at = 0; at < bytes.length; ) {
					const count = Math.min(pending.length - used, bytes.length - at);
					pending.set(bytes.subarray(at, at + count), used);
					at += count;
					used += count;
					if (used === pending.length) flush();
				}
			});
			if (used) flush();
			const hash = createHash("sha1").update(`${type} ${length}\0`);
			for (let index = 0; index < part; index++) hash.update(this.chunk(id, index));
			this.storage.sql.exec(
				"INSERT INTO git_object_meta VALUES (?, ?, ?, ?, ?)",
				this.scope,
				id,
				type,
				length,
				hash.digest("hex"),
			);
			this.storage.sql.exec("UPDATE git_object_budget SET decoded = decoded + ? WHERE scope = ?", length, this.scope);
		});
		return this.get(id);
	}
	private chunk(id: string, part: number): Uint8Array {
		this.active();
		const rows = this.storage.sql
			.exec("SELECT data FROM git_object_bytes WHERE scope = ? AND id = ? AND part = ?", this.scope, id, part)
			.toArray() as { data: ArrayBuffer }[];
		if (rows.length !== 1) throw Error("missing Git object chunk");
		const bytes = new Uint8Array(rows[0]!.data);
		if (!bytes.length || bytes.length > 65536) throw Error("invalid Git object chunk");
		return bytes;
	}
	get(id: string): StoredGitBytes {
		this.active();
		const rows = this.storage.sql
			.exec("SELECT type, bytes, oid FROM git_object_meta WHERE scope = ? AND id = ?", this.scope, id)
			.toArray() as { type: string; bytes: number; oid: string }[];
		if (rows.length !== 1) throw Error("missing Git object");
		const meta = rows[0]!;
		return {
			id,
			oid: meta.oid,
			type: meta.type,
			byteLength: meta.bytes,
			read: (start, length) => {
				this.active();
				if (
					!Number.isSafeInteger(start) ||
					!Number.isSafeInteger(length) ||
					start < 0 ||
					length < 0 ||
					length > 65536 ||
					start + length > meta.bytes
				)
					throw Error("invalid Git object range");
				const result = new Uint8Array(length);
				for (let copied = 0; copied < length; ) {
					const position = start + copied,
						chunk = this.chunk(id, Math.floor(position / 65536));
					const offset = position % 65536,
						count = Math.min(length - copied, chunk.length - offset);
					if (count <= 0) throw Error("truncated Git object chunk");
					result.set(chunk.subarray(offset, offset + count), copied);
					copied += count;
				}
				return result;
			},
		};
	}
	/** Remove obsolete delta instructions without refunding their decoded-work budget. */
	remove(id: string): void {
		this.active();
		this.storage.sql.exec("DELETE FROM git_object_bytes WHERE scope = ? AND id = ?", this.scope, id);
		this.storage.sql.exec("DELETE FROM git_object_meta WHERE scope = ? AND id = ?", this.scope, id);
	}
	dispose(): void {
		this.closed = true;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM git_object_bytes WHERE scope = ?", this.scope);
			this.storage.sql.exec("DELETE FROM git_object_meta WHERE scope = ?", this.scope);
			this.storage.sql.exec("DELETE FROM git_object_budget WHERE scope = ?", this.scope);
		});
	}
}
