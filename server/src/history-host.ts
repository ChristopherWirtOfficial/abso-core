import { MemoryStore, Project } from "../../worker/project/project.ts";
import { withDecodedFrames } from "./decoded-frames.ts";
import type { SqliteLog, SqliteStorage } from "./engine-project.ts";
import { SqliteHistoryState } from "./history-state.ts";
import type { WriterProjectionSession } from "./writer-host.ts";
import { SqliteWriterState, type WriterRoot, writerFrameChunksDigest } from "./writer-host.ts";

type Cursor = { root: WriterRoot; next: number; digest: string };
const same = (a: WriterRoot, b: WriterRoot) =>
	a.format === b.format &&
	a.generation === b.generation &&
	a.logLength === b.logLength &&
	a.sharedVersion === b.sharedVersion &&
	a.digest === b.digest;

/** Derived historical state, bound to the host's exact canonical root. */
export class SqliteHistoryHost {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	readonly #meta: SqliteWriterState;
	constructor(storage: SqliteStorage, namespace: string) {
		if (!namespace || namespace.length > 80) throw Error("invalid historical host namespace");
		this.#storage = storage;
		this.#namespace = namespace;
		this.#meta = new SqliteWriterState(storage, `${namespace}:control`);
	}
	#validate(root: WriterRoot, currentRoot: () => WriterRoot, authority: () => void) {
		const result: unknown = authority();
		if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
			throw Error("historical authority must be synchronous");
		if (!same(root, currentRoot())) throw Error("historical canonical root changed");
	}
	#beginReset() {
		this.#meta.remove("history", "cursor");
		this.#meta.remove("history", "verification");
		this.#meta.write("history", "reset", true);
		return { ready: false, next: 0 };
	}
	#resetPage() {
		const sql = this.#storage.sql;
		const clauses: [string, string, (string | number)[]][] = [
			["writer_state", "namespace = ?", [this.#namespace]],
			[
				"writer_state",
				"namespace >= ? AND namespace < ?",
				[`${this.#namespace}:history:`, `${this.#namespace}:history;`],
			],
			["writer_history_keys", "namespace = ?", [this.#namespace]],
			["writer_history_heads", "namespace = ?", [this.#namespace]],
		];
		for (const [table, condition, bindings] of clauses) {
			const rows = sql.exec(`SELECT rowid AS id FROM ${table} WHERE ${condition} LIMIT 256`, ...bindings).toArray() as {
				id: number;
			}[];
			if (!rows.length) continue;
			sql.exec(`DELETE FROM ${table} WHERE rowid IN (${rows.map(() => "?").join(",")})`, ...rows.map((row) => row.id));
			return { ready: false, next: 0 };
		}
		this.#meta.remove("history", "reset");
		return { ready: false, next: 0 };
	}

	prepare(log: SqliteLog, root: WriterRoot, currentRoot: () => WriterRoot, authority: () => void) {
		return this.#storage.transactionSync(() => {
			this.#validate(root, currentRoot, authority);
			SqliteHistoryState.initialize(this.#storage);
			if (this.#meta.read("history", "reset") === true) {
				const result = this.#resetPage();
				this.#validate(root, currentRoot, authority);
				return result;
			}
			let cursor = this.#meta.read("history", "cursor") as Cursor | undefined;
			if (cursor && !same(cursor.root, root)) {
				if (cursor.next > root.logLength) return this.#beginReset();
				const saved = this.#meta.read("history", "verification") as Cursor | undefined;
				const verification = saved && same(saved.root, root) ? saved : { root, next: 0, digest: "" };
				const budget = log.adoptionPageBytes(verification.next);
				let bytes = 0,
					count = 0;
				while (verification.next < cursor.next && count < 32) {
					const size = log.frameBytes(verification.next);
					if (bytes && size > budget - bytes) break;
					verification.digest = writerFrameChunksDigest(
						verification.digest,
						verification.next,
						log.frameChunks(verification.next),
					);
					verification.next++;
					bytes += size;
					count++;
				}
				this.#validate(root, currentRoot, authority);
				if (verification.next < cursor.next) {
					this.#meta.write("history", "verification", verification);
					return { ready: false, next: cursor.next };
				}
				if (verification.digest !== cursor.digest) return this.#beginReset();
				cursor = { ...cursor, root };
				this.#meta.write("history", "cursor", cursor);
				this.#meta.remove("history", "verification");
			}
			if (cursor?.next === root.logLength) return { ready: true, next: cursor.next };
			const from = cursor?.next ?? 0;
			const state = new SqliteHistoryState(this.#storage, this.#namespace, from);
			let digest = cursor?.digest ?? "";
			const budget = log.adoptionPageBytes(from);
			const decoded = withDecodedFrames(
				this.#storage,
				`${this.#namespace}:decoded`,
				log,
				{ from, to: root.logLength, maxEntries: 32, maxBytes: budget, digest },
				(frames) => {
					const page =
						from > 0
							? (() => {
									const extended = Project.extendHistoricalPage(state, {
										from,
										frames,
										maxEntries: 32,
										maxBytes: budget,
										decodedFrames: true,
										beginRevision: (revision) => state.beginRevision(revision),
										validateAuthority: () => this.#validate(root, currentRoot, authority),
									});
									return { ...extended, ready: extended.next === root.logLength };
								})()
							: Project.adoptWriterPage(state, {
									source: root,
									from,
									frames,
									maxEntries: 32,
									maxBytes: budget,
									decodedFrames: true,
									currentSource: () => currentRoot(),
									beginRevision: (revision) => state.beginRevision(revision),
								});
					return page;
				},
			);
			const page = decoded.result;
			digest = decoded.digest;
			if (page.ready && digest !== root.digest) throw Error("historical canonical digest mismatch");
			this.#validate(root, currentRoot, authority);
			state.seal();
			this.#meta.write("history", "cursor", { root, next: page.next, digest } satisfies Cursor);
			return { ready: page.ready, next: page.next };
		});
	}
	/** Called inside the canonical writer transaction, before its receipt commits. */
	advance(
		log: SqliteLog,
		previous: WriterRoot,
		committed: WriterRoot,
		currentRoot: () => WriterRoot,
		authority: () => void,
	): void {
		this.#storage.transactionSync(() => {
			const validate = () => this.#validate(committed, currentRoot, authority);
			validate();
			const cursor = this.#meta.read("history", "cursor") as Cursor | undefined;
			if (
				!cursor ||
				!same(cursor.root, previous) ||
				cursor.next !== previous.logLength ||
				cursor.digest !== previous.digest
			)
				throw Error("historical committed prefix is stale");
			if (committed.logLength < previous.logLength || committed.generation < previous.generation)
				throw Error("historical root cannot move backwards");
			let from = previous.logLength,
				digest = previous.digest;
			while (from < committed.logLength) {
				const budget = log.adoptionPageBytes(from);
				const state = new SqliteHistoryState(this.#storage, this.#namespace, from);
				const decoded = withDecodedFrames(
					this.#storage,
					`${this.#namespace}:decoded`,
					log,
					{ from, to: committed.logLength, maxEntries: 32, maxBytes: budget, digest },
					(frames) => {
						const page = Project.extendHistoricalPage(state, {
							from,
							frames,
							maxEntries: 32,
							maxBytes: budget,
							decodedFrames: true,
							beginRevision: (revision) => state.beginRevision(revision),
							validateAuthority: validate,
						});
						return page;
					},
				);
				const page = decoded.result;
				digest = decoded.digest;
				state.seal();
				from = page.next;
			}
			if (digest !== committed.digest) throw Error("historical canonical tail digest mismatch");
			validate();
			this.#meta.write("history", "cursor", { root: committed, next: from, digest } satisfies Cursor);
		});
	}
	read<T>(
		root: WriterRoot,
		currentRoot: () => WriterRoot,
		authority: () => void,
		at: number,
		operation: (project: Project) => T,
		viewProvider?: WriterProjectionSession["historicalReadViewProvider"],
	): T {
		return this.#storage.transactionSync(() => {
			let active = true;
			const assertScope = () => {
				if (!active) throw Error("historical scope ended");
			};
			const validate = () => {
				assertScope();
				this.#validate(root, currentRoot, authority);
			};
			try {
				validate();
				const cursor = this.#meta.read("history", "cursor") as Cursor | undefined;
				if (!cursor || !same(cursor.root, root) || cursor.next !== root.logLength || cursor.digest !== root.digest)
					throw Error("historical state is not ready for canonical root");
				if (!Number.isSafeInteger(at) || at < 0 || at > root.logLength)
					throw Error("historical position outside authority");
				const state = new SqliteHistoryState(this.#storage, this.#namespace, root.logLength);
				const historical = state.at(at, assertScope);
				const project =
					at === 0
						? new Project(new MemoryStore())
						: Project.openHistorical(
								historical,
								at,
								new SqliteWriterState(this.#storage, `${this.#namespace}:scratch`),
								assertScope,
								viewProvider?.(historical),
							);
				const result = structuredClone(operation(project));
				validate();
				return result;
			} finally {
				active = false;
			}
		});
	}
}
