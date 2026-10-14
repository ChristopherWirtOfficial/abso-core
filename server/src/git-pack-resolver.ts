import type { SqliteStorage } from "./engine-project.ts";
import { applyGitDeltaChunks } from "./git-delta-stream.ts";
import { GitObjectBytes, type StoredGitBytes } from "./git-object-bytes.ts";

/** Scratch index and decoded objects for one pack. No in-memory object map. */
export class GitPackResolver {
	readonly scope = crypto.randomUUID();
	readonly objects: GitObjectBytes;
	private readonly storage: SqliteStorage;
	private readonly maxObjectBytes: number;
	private closed = false;
	constructor(storage: SqliteStorage, maxObjectBytes: number, maxDecodedBytes = maxObjectBytes) {
		if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 0) throw Error("invalid object limit");
		this.storage = storage;
		this.maxObjectBytes = maxObjectBytes;
		this.objects = new GitObjectBytes(storage, maxDecodedBytes);
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS git_pack_resolve (scope TEXT, offset INTEGER, raw TEXT, base_offset INTEGER, base_oid TEXT, result TEXT, oid TEXT, depth INTEGER, PRIMARY KEY(scope,offset))",
		);
		storage.sql.exec("CREATE INDEX IF NOT EXISTS git_pack_resolve_oid ON git_pack_resolve(scope,oid)");
		storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS git_pack_unresolved ON git_pack_resolve(scope,offset) WHERE result IS NULL",
		);
	}
	private active(): void {
		if (this.closed) throw Error("pack resolver is closed");
	}
	add(offset: number, type: string, data: Uint8Array, base?: number | string): void {
		this.addChunks(offset, type, (write) => write(data), base);
	}
	/** The inflater writes bounded output directly into the transactional object store. */
	addChunks(
		offset: number,
		type: string,
		produce: (write: (bytes: Uint8Array) => void) => void,
		base?: number | string,
	): void {
		this.active();
		if (!Number.isSafeInteger(offset) || offset < 12) throw Error("invalid pack offset");
		if (type === "delta") {
			if (
				typeof base === "number"
					? !Number.isSafeInteger(base) || base < 12 || base >= offset
					: typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)
			)
				throw Error("invalid delta base reference");
		} else if (base !== undefined) throw Error("ordinary object has delta base");
		this.storage.transactionSync(() => {
			const stored = this.objects.put(type === "delta" ? "blob" : type, produce, this.maxObjectBytes);
			this.storage.sql.exec(
				"INSERT INTO git_pack_resolve VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				this.scope,
				offset,
				stored.id,
				typeof base === "number" ? base : null,
				typeof base === "string" ? base : null,
				type === "delta" ? null : stored.id,
				type === "delta" ? null : stored.oid,
				type === "delta" ? null : 0,
			);
		});
	}
	resolve(): void {
		this.active();
		this.storage.transactionSync(() => {
			for (;;) {
				const rows = this.storage.sql
					.exec(
						`SELECT p.offset, p.raw, COALESCE(b.result, r.result) AS base, COALESCE(b.depth, r.depth) AS depth
FROM git_pack_resolve p
LEFT JOIN git_pack_resolve b ON b.scope = p.scope AND b.offset = p.base_offset
LEFT JOIN git_pack_resolve r ON r.scope = p.scope AND r.oid = p.base_oid
WHERE p.scope = ? AND p.result IS NULL AND (b.result IS NOT NULL OR r.result IS NOT NULL)
ORDER BY p.offset LIMIT 1`,
						this.scope,
					)
					.toArray() as {
					offset: number;
					raw: string;
					base: string;
					depth: number;
				}[];
				if (!rows.length) break;
				const row = rows[0]!;
				if (row.depth >= 64) throw Error("Git delta chain exceeds depth limit");
				const base = this.objects.get(row.base),
					delta = this.objects.get(row.raw);
				const result = this.objects.put(
					base.type,
					(write) => {
						applyGitDeltaChunks(delta, base, write, this.maxObjectBytes);
					},
					this.maxObjectBytes,
				);
				this.storage.sql.exec(
					"UPDATE git_pack_resolve SET result = ?, oid = ?, depth = ? WHERE scope = ? AND offset = ?",
					result.id,
					result.oid,
					row.depth + 1,
					this.scope,
					row.offset,
				);
				this.objects.remove(row.raw);
			}
			if (
				this.storage.sql
					.exec("SELECT offset FROM git_pack_resolve WHERE scope = ? AND result IS NULL LIMIT 1", this.scope)
					.toArray().length
			)
				throw Error("unresolved or cyclic Git delta base");
		});
	}
	get(oid: string): StoredGitBytes {
		const value = this.find(oid);
		if (!value) throw Error("missing packed Git object");
		return value;
	}
	find(oid: string): StoredGitBytes | undefined {
		this.active();
		const rows = this.storage.sql
			.exec("SELECT result FROM git_pack_resolve WHERE scope = ? AND oid = ? LIMIT 1", this.scope, oid)
			.toArray() as { result: string }[];
		if (!rows.length) return undefined;
		return this.objects.get(rows[0]!.result);
	}
	dispose(): void {
		this.closed = true;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM git_pack_resolve WHERE scope = ?", this.scope);
			this.objects.dispose();
		});
	}
}
