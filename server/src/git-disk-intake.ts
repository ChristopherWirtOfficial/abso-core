import type { SqliteStorage } from "./engine-project.ts";
import type { StoredGitBytes } from "./git-object-bytes.ts";
import { decodeGitPack, type PackInflater } from "./git-pack-decode.ts";
import { GitPackResolver } from "./git-pack-resolver.ts";
import { GitPackSpool } from "./git-pack-spool.ts";

/** One clone's temporary pack store. The caller must dispose it in finally. */
export class GitDiskIntake {
	/** Cold object construction only, before any intake or reader is created. */
	static recover(storage: SqliteStorage): void {
		// Constructors establish scratch tables only; they do not alter project state.
		const resolver = new GitPackResolver(storage, 0);
		storage.transactionSync(() => {
			GitPackSpool.recover(storage);
			storage.sql.exec("DELETE FROM git_pack_resolve");
			storage.sql.exec("DELETE FROM git_object_bytes");
			storage.sql.exec("DELETE FROM git_object_meta");
			storage.sql.exec("DELETE FROM git_object_budget");
		});
		resolver.dispose();
	}
	private readonly spool: GitPackSpool;
	private readonly resolver: GitPackResolver;
	private readonly maxPackBytes: number;
	private state: "new" | "loading" | "ready" | "closed" = "new";
	constructor(storage: SqliteStorage, maxPackBytes: number, maxObjectBytes: number, maxDecodedBytes = maxPackBytes) {
		if (!Number.isSafeInteger(maxPackBytes) || maxPackBytes < 32) throw Error("invalid pack limit");
		this.maxPackBytes = maxPackBytes;
		this.resolver = new GitPackResolver(storage, maxObjectBytes, maxDecodedBytes);
		this.spool = new GitPackSpool(storage);
	}
	attach(cache: object): void {
		const key = Symbol.for("abso.git.disk-pack");
		if (key in cache) throw Error("Git disk intake already attached");
		Object.defineProperty(cache, key, { value: this });
	}
	async ingest(
		chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | AsyncIterator<Uint8Array>,
		createInflater: () => PackInflater,
	): Promise<void> {
		if (this.state !== "new") throw Error("Git disk intake already used");
		this.state = "loading";
		const iterator =
			Symbol.asyncIterator in chunks
				? chunks[Symbol.asyncIterator]()
				: Symbol.iterator in chunks
					? chunks[Symbol.iterator]()
					: chunks;
		try {
			const source = {
				[Symbol.asyncIterator]: () => ({
					next: async () => iterator.next(),
					return: async () => (iterator.return ? iterator.return() : { done: true as const, value: undefined }),
				}),
			};
			await this.spool.ingest(source, this.maxPackBytes);
			if (this.state !== "loading") throw Error("Git disk intake closed during download");
			decodeGitPack(this.spool, this.resolver, createInflater);
			this.spool.dispose();
			this.state = "ready";
		} catch (error) {
			try {
				await iterator.return?.();
			} catch {
				/* Preserve the intake failure. */
			}
			this.dispose();
			throw error;
		}
	}
	bytes(oid: string): StoredGitBytes | undefined {
		if (this.state === "closed") throw Error("Git disk intake is closed");
		if (this.state !== "ready") return undefined;
		return this.resolver.find(oid);
	}
	read(oid: string): { format: "content"; type: string; object: Buffer } | undefined {
		const stored = this.bytes(oid);
		if (!stored) return undefined;
		// Existing Git consumers require one complete object. This does not claim
		// bounded blob consumption; it removes whole-pack retention and caching.
		const object = Buffer.alloc(stored.byteLength);
		for (let at = 0; at < stored.byteLength; at += 65536) {
			object.set(stored.read(at, Math.min(65536, stored.byteLength - at)), at);
		}
		return { format: "content", type: stored.type, object };
	}
	assertReady(): void {
		if (this.state !== "ready") throw Error("Git disk intake was not used by the installed runtime");
	}
	[Symbol.dispose](): void {
		this.dispose();
	}
	dispose(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		try {
			this.resolver.dispose();
		} finally {
			this.spool.dispose();
		}
	}
}
