import { StoredText } from "../../src/engine/stored-text.ts";
import type { SqliteStorage } from "./engine-project.ts";
import type { PushedCommits } from "./ingest.ts";
import { SqliteWriterState } from "./writer-host.ts";

type Tree = Pick<PushedCommits["commits"][number], "files" | "modes" | "blobs">;

/** Keeps earlier Git trees on disk while later commits are decoded. */
export class GitIntakeTrees {
	/** Only at a cold Durable Object start, before any intake can be active. */
	static recover(storage: SqliteStorage): void {
		SqliteWriterState.initialize(storage);
		storage.sql.exec("DELETE FROM writer_state WHERE namespace GLOB 'git-intake:*'");
	}
	readonly namespace = `git-intake:${crypto.randomUUID()}`;
	readonly storage: SqliteStorage;
	readonly text: StoredText;
	private next = 0;
	private active = true;
	constructor(storage: SqliteStorage) {
		this.storage = storage;
		SqliteWriterState.initialize(storage);
		this.text = new StoredText(new SqliteWriterState(storage, this.namespace), "files");
	}
	/** Created outside any scope containing decoded file text or a whole tree. */
	private getter(key: string): () => string {
		return () => {
			if (!this.active) throw Error("Git intake trees are closed");
			return this.text.read(key);
		};
	}
	retainFile(files: Record<string, string>, path: string, body: string, oid?: string): void {
		this.retainChunks(
			files,
			path,
			(function* () {
				for (let at = 0; at < body.length; at += StoredText.chunkCharacters)
					yield body.slice(at, at + StoredText.chunkCharacters);
			})(),
			oid,
		);
	}
	retainChunks(files: Record<string, string>, path: string, chunks: Iterable<string>, oid?: string): void {
		if (!this.active) throw Error("Git intake trees are closed");
		if (oid !== undefined && !/^[0-9a-f]{40}$/.test(oid)) throw Error("Invalid Git blob id");
		const key = oid === undefined ? String(this.next++) : `blob:${oid}`;
		this.storage.transactionSync(() => {
			if (this.text.storage.read(this.text.collection, key) === undefined) this.text.writeChunks(key, chunks);
		});
		Object.defineProperty(files, path, {
			enumerable: true,
			get: this.getter(key),
		});
	}
	retain(tree: Tree): Tree {
		if (!this.active) throw Error("Git intake trees are closed");
		const files: Record<string, string> = Object.create(null);
		this.storage.transactionSync(() => {
			for (const path of Object.keys(tree.files)) {
				const key = String(this.next++);
				this.text.write(key, tree.files[path]!);
				Object.defineProperty(files, path, {
					enumerable: true,
					get: this.getter(key),
				});
			}
		});
		return { files, modes: tree.modes, blobs: tree.blobs };
	}
	[Symbol.dispose](): void {
		this.dispose();
	}
	dispose(): void {
		this.active = false;
		this.storage.sql.exec("DELETE FROM writer_state WHERE namespace = ?", this.namespace);
	}
}
