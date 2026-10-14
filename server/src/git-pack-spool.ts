import { createHash } from "node:crypto";
import type { SqliteStorage } from "./engine-project.ts";

/** Temporary verified pack bytes. No whole-pack read API is exposed. */
export class GitPackSpool {
	static readonly chunkBytes = 65536;
	/** Cold Durable Object construction only, before any intake starts. */
	static recover(storage: SqliteStorage): void {
		GitPackSpool.initialize(storage);
		storage.sql.exec("DELETE FROM git_pack_spool");
	}
	private static initialize(storage: SqliteStorage): void {
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS git_pack_spool (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))",
		);
	}
	readonly id = crypto.randomUUID();
	private size = 0;
	private sealed = false;
	private closed = false;
	private readonly storage: SqliteStorage;
	constructor(storage: SqliteStorage) {
		this.storage = storage;
		GitPackSpool.initialize(storage);
	}
	get byteLength(): number {
		this.assertReadable();
		return this.size;
	}
	private assertReadable(): void {
		if (!this.sealed || this.closed) throw Error("pack spool is not readable");
	}
	async ingest(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number): Promise<string> {
		if (this.size || this.sealed || this.closed) throw Error("pack spool already used");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) throw Error("invalid pack byte limit");
		const hash = createHash("sha1");
		let tail = new Uint8Array(0);
		let pending = new Uint8Array(GitPackSpool.chunkBytes),
			used = 0,
			part = 0;
		const save = () => {
			if (this.closed) throw Error("pack spool is closed");
			this.storage.sql.exec("INSERT INTO git_pack_spool VALUES (?, ?, ?)", this.id, part++, pending.slice(0, used));
			used = 0;
		};
		try {
			for await (const chunk of chunks) {
				if (this.closed) throw Error("pack spool is closed");
				if (!(chunk instanceof Uint8Array)) throw Error("invalid pack chunk");
				for (let at = 0; at < chunk.length; ) {
					const count = Math.min(GitPackSpool.chunkBytes - used, chunk.length - at);
					if (this.size + count > maxBytes) throw Error("pack exceeds byte limit");
					const piece = chunk.subarray(at, at + count);
					const joined = new Uint8Array(tail.length + piece.length);
					joined.set(tail);
					joined.set(piece, tail.length);
					const end = Math.max(0, joined.length - 20);
					hash.update(joined.subarray(0, end));
					tail = joined.slice(end);
					pending.set(piece, used);
					used += count;
					at += count;
					this.size += count;
					if (used === pending.length) save();
				}
			}
			if (used) save();
			if (this.size < 32 || tail.length !== 20) throw Error("truncated pack");
			const digest = hash.digest("hex");
			if (digest !== Buffer.from(tail).toString("hex")) throw Error("pack checksum mismatch");
			this.sealed = true;
			const header = this.read(0, 12);
			if (new TextDecoder().decode(header.subarray(0, 4)) !== "PACK" || new DataView(header.buffer).getUint32(4) !== 2)
				throw Error("unsupported pack header");
			return digest;
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
	read(start: number, length: number): Uint8Array {
		this.assertReadable();
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(length) ||
			start < 0 ||
			length < 0 ||
			length > GitPackSpool.chunkBytes ||
			start + length > this.size
		)
			throw Error("invalid pack byte range");
		const result = new Uint8Array(length);
		let copied = 0;
		while (copied < length) {
			const position = start + copied,
				part = Math.floor(position / GitPackSpool.chunkBytes);
			const rows = this.storage.sql
				.exec("SELECT data FROM git_pack_spool WHERE id = ? AND part = ?", this.id, part)
				.toArray() as { data: ArrayBuffer }[];
			if (rows.length !== 1) throw Error("missing pack chunk");
			const data = new Uint8Array(rows[0]!.data),
				offset = position % GitPackSpool.chunkBytes;
			const count = Math.min(length - copied, data.length - offset);
			if (count <= 0 || data.length > GitPackSpool.chunkBytes) throw Error("invalid pack chunk");
			result.set(data.subarray(offset, offset + count), copied);
			copied += count;
		}
		return result;
	}
	*chunks(): IterableIterator<Uint8Array> {
		this.assertReadable();
		for (let start = 0; start < this.size; start += GitPackSpool.chunkBytes)
			yield this.read(start, Math.min(GitPackSpool.chunkBytes, this.size - start));
	}
	dispose(): void {
		this.closed = true;
		this.storage.sql.exec("DELETE FROM git_pack_spool WHERE id = ?", this.id);
	}
}
