import type { SqliteStorage } from "./engine-project.ts";
import type { FileContents } from "./memory-fs.ts";

function initialize(storage: SqliteStorage): void {
	storage.sql.exec(
		"CREATE TABLE IF NOT EXISTS git_fs_meta (scope TEXT, path TEXT, bytes INTEGER, PRIMARY KEY(scope,path))",
	);
	storage.sql.exec(
		"CREATE TABLE IF NOT EXISTS git_fs_chunks (scope TEXT, path TEXT, part INTEGER, data BLOB NOT NULL, PRIMARY KEY(scope,path,part))",
	);
	storage.sql.exec("CREATE TABLE IF NOT EXISTS git_fs_budget (scope TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
}

/** One Git operation's scratch files. Reads materialize one file, never the whole filesystem. */
export class GitFileContents implements FileContents {
	static recover(storage: SqliteStorage): void {
		initialize(storage);
		storage.transactionSync(() => {
			for (const table of ["git_fs_chunks", "git_fs_meta", "git_fs_budget"]) storage.sql.exec(`DELETE FROM ${table}`);
		});
	}
	readonly scope = crypto.randomUUID();
	private readonly storage: SqliteStorage;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private closed = false;
	constructor(storage: SqliteStorage, maxFileBytes: number, maxTotalBytes: number) {
		if (![maxFileBytes, maxTotalBytes].every((n) => Number.isSafeInteger(n) && n >= 0))
			throw Error("invalid Git scratch limits");
		this.storage = storage;
		this.maxFileBytes = maxFileBytes;
		this.maxTotalBytes = maxTotalBytes;
		initialize(storage);
		storage.sql.exec("INSERT INTO git_fs_budget VALUES (?, 0)", this.scope);
	}
	private active(): void {
		if (this.closed) throw Error("Git scratch files are closed");
	}
	private size(path: string): number | undefined {
		const rows = this.storage.sql
			.exec("SELECT bytes FROM git_fs_meta WHERE scope = ? AND path = ?", this.scope, path)
			.toArray() as { bytes: number }[];
		return rows[0]?.bytes;
	}
	write(path: string, bytes: Uint8Array): void {
		this.active();
		if (bytes.byteLength > this.maxFileBytes) throw Error("Git scratch file exceeds byte limit");
		this.storage.transactionSync(() => {
			const old = this.size(path) ?? 0;
			const rows = this.storage.sql.exec("SELECT bytes FROM git_fs_budget WHERE scope = ?", this.scope).toArray() as {
				bytes: number;
			}[];
			if (rows.length !== 1) throw Error("missing Git scratch budget");
			const next = rows[0]!.bytes - old + bytes.byteLength;
			if (!Number.isSafeInteger(next) || next < 0 || next > this.maxTotalBytes)
				throw Error("Git scratch exceeds total byte limit");
			this.storage.sql.exec("DELETE FROM git_fs_chunks WHERE scope = ? AND path = ?", this.scope, path);
			for (let at = 0; at < bytes.byteLength; at += 65536)
				this.storage.sql.exec(
					"INSERT INTO git_fs_chunks VALUES (?, ?, ?, ?)",
					this.scope,
					path,
					at / 65536,
					bytes.slice(at, at + 65536),
				);
			this.storage.sql.exec("INSERT OR REPLACE INTO git_fs_meta VALUES (?, ?, ?)", this.scope, path, bytes.byteLength);
			this.storage.sql.exec("UPDATE git_fs_budget SET bytes = ? WHERE scope = ?", next, this.scope);
		});
	}
	read(path: string): Uint8Array {
		this.active();
		const size = this.size(path);
		if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > this.maxFileBytes)
			throw Error("invalid Git scratch file");
		const bytes = new Uint8Array(size);
		for (let at = 0; at < size; at += 65536) {
			const rows = this.storage.sql
				.exec("SELECT data FROM git_fs_chunks WHERE scope = ? AND path = ? AND part = ?", this.scope, path, at / 65536)
				.toArray() as { data: ArrayBuffer }[];
			if (rows.length !== 1) throw Error("missing Git scratch chunk");
			const chunk = new Uint8Array(rows[0]!.data);
			if (chunk.byteLength !== Math.min(65536, size - at)) throw Error("invalid Git scratch chunk");
			bytes.set(chunk, at);
		}
		return bytes;
	}
	remove(path: string): void {
		this.active();
		this.storage.transactionSync(() => {
			const size = this.size(path);
			if (size === undefined) throw Error("missing Git scratch file");
			this.storage.sql.exec("DELETE FROM git_fs_chunks WHERE scope = ? AND path = ?", this.scope, path);
			this.storage.sql.exec("DELETE FROM git_fs_meta WHERE scope = ? AND path = ?", this.scope, path);
			this.storage.sql.exec("UPDATE git_fs_budget SET bytes = bytes - ? WHERE scope = ?", size, this.scope);
		});
	}
	[Symbol.dispose](): void {
		this.dispose();
	}
	dispose(): void {
		if (this.closed) return;
		this.storage.transactionSync(() => {
			for (const table of ["git_fs_chunks", "git_fs_meta", "git_fs_budget"])
				this.storage.sql.exec(`DELETE FROM ${table} WHERE scope = ?`, this.scope);
		});
		this.closed = true;
	}
}
