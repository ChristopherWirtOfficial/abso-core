// Shared SQLite writer host.
// Callers provide current authority and own activation; this module adds no route.
import { createHash } from "node:crypto";
import { indexAcceptedProjectionAtom } from "../../src/engine/experimental/projection-atom-index.ts";
import type { GraphStateStorage } from "../../src/engine/state-source.ts";
import { Project, type WriterSource } from "../../worker/project/project.ts";
import type { ProjectOptions } from "../../worker/project/project-types.ts";
import { withDecodedFrames } from "./decoded-frames.ts";
import {
	EngineProject,
	logParts,
	LOG_PART_CHARACTERS as PART,
	SqliteLog,
	type SqliteStorage,
} from "./engine-project.ts";
import type { SqliteHistoryHost } from "./history-host.ts";

export class SqliteWriterState implements GraphStateStorage {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	static readonly maxValueBytes = 8_000_000;
	constructor(storage: SqliteStorage, namespace: string) {
		if (!namespace || namespace.length > 128) throw new Error("invalid writer-state namespace");
		this.#storage = storage;
		this.#namespace = namespace;
	}
	/** Explicit schema setup, reserved for an authorized adoption host. */
	static initialize(storage: SqliteStorage): void {
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS writer_state (namespace TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, collection, key, part))",
		);
	}
	read(collection: string, key: string): unknown {
		const header = this.#storage.sql
			.exec(
				"SELECT value FROM writer_state WHERE namespace = ? AND collection = ? AND key = ? AND part = -1",
				this.#namespace,
				collection,
				key,
			)
			.toArray() as { value: string }[];
		if (!header.length) return undefined;
		const meta = JSON.parse(header[0]!.value) as { parts: number; characters: number; bytes: number };
		if (
			!Number.isSafeInteger(meta.parts) ||
			meta.parts < 1 ||
			meta.parts > Math.ceil(SqliteWriterState.maxValueBytes / (PART - 1)) ||
			!Number.isSafeInteger(meta.characters) ||
			meta.characters < 1 ||
			meta.characters > SqliteWriterState.maxValueBytes ||
			!Number.isSafeInteger(meta.bytes) ||
			meta.bytes < 1 ||
			meta.bytes > SqliteWriterState.maxValueBytes
		)
			throw new Error("invalid writer-state value header");
		const rows = this.#storage.sql
			.exec(
				"SELECT part, value FROM writer_state WHERE namespace = ? AND collection = ? AND key = ? AND part >= 0 ORDER BY part LIMIT ?",
				this.#namespace,
				collection,
				key,
				meta.parts + 1,
			)
			.toArray() as { part: number; value: string }[];
		if (rows.length !== meta.parts || rows.some((row, index) => row.part !== index || row.value.length > PART))
			throw new Error("incomplete writer-state value");
		const json = rows.map((row) => row.value).join("");
		if (json.length !== meta.characters || new TextEncoder().encode(json).byteLength !== meta.bytes)
			throw new Error("writer-state value length mismatch");
		return (JSON.parse(json) as { value?: unknown }).value;
	}
	write(collection: string, key: string, value: unknown): void {
		const json = JSON.stringify({ value });
		if (json.length > SqliteWriterState.maxValueBytes) throw new Error("writer-state value exceeds byte bound");
		const bytes = new TextEncoder().encode(json).byteLength;
		if (bytes > SqliteWriterState.maxValueBytes) throw new Error("writer-state value exceeds byte bound");
		const parts = logParts(json);
		this.transaction(() => {
			this.remove(collection, key);
			this.#storage.sql.exec(
				"INSERT INTO writer_state VALUES (?, ?, ?, -1, ?)",
				this.#namespace,
				collection,
				key,
				JSON.stringify({ parts: parts.length, characters: json.length, bytes }),
			);
			for (const [part, text] of parts.entries())
				this.#storage.sql.exec(
					"INSERT INTO writer_state VALUES (?, ?, ?, ?, ?)",
					this.#namespace,
					collection,
					key,
					part,
					text,
				);
		});
	}
	remove(collection: string, key: string): void {
		this.#storage.sql.exec(
			"DELETE FROM writer_state WHERE namespace = ? AND collection = ? AND key = ?",
			this.#namespace,
			collection,
			key,
		);
	}
	/** Delete one owned temporary projection collection without reading its values. */
	clearProjectionOverlay(collection: string): void {
		if (!collection.startsWith("projection:temporary:") || collection === "projection:temporary:")
			throw Error("invalid temporary projection collection");
		this.#storage.sql.exec(
			"DELETE FROM writer_state WHERE namespace = ? AND collection = ?",
			this.#namespace,
			collection,
		);
	}
	*entries(collection: string): Iterable<readonly [string, unknown]> {
		let after: string | undefined;
		for (;;) {
			const rows = (
				after === undefined
					? this.#storage.sql.exec(
							"SELECT key FROM writer_state WHERE namespace = ? AND collection = ? AND part = -1 ORDER BY key LIMIT 1",
							this.#namespace,
							collection,
						)
					: this.#storage.sql.exec(
							"SELECT key FROM writer_state WHERE namespace = ? AND collection = ? AND part = -1 AND key > ? ORDER BY key LIMIT 1",
							this.#namespace,
							collection,
							after,
						)
			).toArray() as { key: string }[];
			if (!rows.length) return;
			after = rows[0]!.key;
			yield [after, this.read(collection, after)];
		}
	}
	transaction<T>(body: () => T): T {
		return this.#storage.transactionSync(body);
	}
}

export interface WriterRoot extends WriterSource {
	readonly format: 1;
	readonly digest: string;
}

/** Domain-separated SHA-256 chain over exact canonical UTF-8 frames and their positions. */
export function writerFrameDigest(previous: string, seq: number, json: string): string {
	return writerFrameChunksDigest(previous, seq, [json]);
}

/** Same canonical digest without retaining the complete frame. */
export function writerFrameChunksDigest(previous: string, seq: number, chunks: Iterable<string>): string {
	const hash = createHash("sha256")
		.update("abso-writer-log-v1\n")
		.update(JSON.stringify([previous, seq]))
		.update("\n");
	let carry = "";
	for (const chunk of chunks) {
		const text = carry + chunk;
		const last = text.charCodeAt(text.length - 1);
		const split = last >= 0xd800 && last <= 0xdbff;
		carry = split ? text.slice(-1) : "";
		hash.update(split ? text.slice(0, -1) : text, "utf8");
	}
	if (carry) hash.update(carry, "utf8");
	return hash.digest("hex");
}

export function advanceWriterRoot(log: SqliteLog, previous: WriterRoot, source: WriterSource): WriterRoot {
	let digest = previous.digest;
	if (source.logLength < previous.logLength) throw new Error("writer root cannot move backwards");
	for (let seq = previous.logLength; seq < source.logLength; seq++)
		digest = writerFrameChunksDigest(digest, seq, log.frameChunks(seq));
	return { format: 1, ...source, digest };
}

/** Inactive host for explicit adoption and synchronous fenced writer operations. */
export interface WriterProjectionSession {
	readonly readViewProvider: NonNullable<ProjectOptions["readViewProvider"]>;
	historicalReadViewProvider?(state: GraphStateStorage): NonNullable<ProjectOptions["readViewProvider"]>;
	commit(project: Project, root: WriterRoot): void;
	/** Cleanup is inside the canonical transaction. Any failure aborts roots and receipt too. */
	close(): void;
}

/** Private integration hook. No endpoint or persisted setting enables it. */
export interface WriterProjectionHost {
	open(input: { state: SqliteWriterState; log: SqliteLog; root: WriterRoot }): WriterProjectionSession;
}

export class SqliteWriterHost {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	readonly #state: SqliteWriterState;
	readonly #log: SqliteLog;
	readonly #projection?: WriterProjectionHost;
	readonly #indexProjectionAtoms: boolean;
	readonly #history?: SqliteHistoryHost;
	constructor(
		storage: SqliteStorage,
		namespace: string,
		projection?: WriterProjectionHost,
		options: { indexProjectionAtoms?: boolean; history?: SqliteHistoryHost } = {},
	) {
		this.#storage = storage;
		this.#namespace = namespace;
		this.#state = new SqliteWriterState(storage, namespace);
		this.#log = new SqliteLog(storage);
		this.#projection = projection;
		this.#indexProjectionAtoms = options.indexProjectionAtoms ?? false;
		this.#history = options.history;
	}
	#indexOptions(adopting = false) {
		const mode = this.#state.read("host", "projection-atom-index-mode");
		const expected = this.#indexProjectionAtoms ? 1 : 0;
		if (mode !== undefined && mode !== expected) throw Error("writer atom indexing mode mismatch");
		if (mode === undefined && this.#indexProjectionAtoms && (!adopting || this.#state.read("atoms:meta", "length")))
			throw Error("writer atom indexing requires fresh adoption");
		if (mode === undefined && adopting) this.#state.write("host", "projection-atom-index-mode", expected);
		return { indexAcceptedAtom: this.#indexProjectionAtoms ? indexAcceptedProjectionAtom : undefined };
	}

	source(): WriterSource {
		this.#log.refreshSequence();
		const shared = this.#storage.sql.exec("SELECT value FROM counts WHERE name = 'shared'").toArray() as {
			value: number;
		}[];
		if (!Number.isSafeInteger(shared[0]?.value) || shared[0]!.value < 0)
			throw new Error("canonical shared head must be established before writer adoption");
		return { generation: this.#log.generation(), logLength: this.#log.seq(), sharedVersion: shared[0]!.value };
	}
	static #same(a: WriterSource | undefined, b: WriterSource): boolean {
		return a?.generation === b.generation && a.logLength === b.logLength && a.sharedVersion === b.sharedVersion;
	}
	root(): WriterRoot {
		const root = this.#state.read("host", "canonical-root") as WriterRoot | undefined;
		if (root?.format !== 1 || !/^[a-f0-9]{64}$/.test(root.digest) || !SqliteWriterHost.#same(root, this.source()))
			throw new Error("writer canonical root is missing or stale");
		return root;
	}
	static #sync(value: unknown): void {
		if (value && (typeof value === "object" || typeof value === "function") && "then" in value)
			throw new Error("writer transaction callbacks must be synchronous");
	}
	/** Resume one bounded adoption page against an exact source and prior digest. */
	adoptVerifiedPage(
		input: {
			expected: WriterSource;
			from: number;
			digest: string;
			maxEntries: number;
			maxBytes: number;
		},
		validateAuthority: () => void,
	) {
		return this.#storage.transactionSync(() => {
			SqliteWriterHost.#sync(validateAuthority());
			if (!SqliteWriterHost.#same(input.expected, this.source())) throw new Error("adoption source changed");
			if (
				!Number.isSafeInteger(input.from) ||
				input.from < 0 ||
				!Number.isSafeInteger(input.maxEntries) ||
				input.maxEntries < 1 ||
				input.maxEntries > 256 ||
				!Number.isSafeInteger(input.maxBytes) ||
				input.maxBytes < 1 ||
				!(input.digest === "" || /^[a-f0-9]{64}$/.test(input.digest))
			)
				throw new Error("invalid bounded adoption request");
			const request = JSON.stringify([
				input.expected.generation,
				input.expected.logLength,
				input.expected.sharedVersion,
				input.from,
				input.digest,
				input.maxEntries,
				input.maxBytes,
			]);
			const previous = this.#state.read("host", "adoption-page-receipt") as
				| { request: string; result: { next: number; ready: boolean; digest: string } }
				| undefined;
			if (previous?.request === request) return previous.result;
			const cursor = this.#state.read("host", "adoption-root") as { next: number; digest: string } | undefined;
			if ((cursor?.next ?? 0) !== input.from || (cursor?.digest ?? "") !== input.digest)
				throw new Error("adoption cursor or digest changed");
			const page = this.adoptPage(input.from, input, validateAuthority);
			const root = this.#state.read("host", "adoption-root") as { digest: string };
			const result = { next: page.next, ready: page.ready, digest: root.digest };
			this.#state.write("host", "adoption-page-receipt", { request, result });
			return result;
		});
	}
	adoptPage(from: number, limits: { maxEntries: number; maxBytes: number }, validateAuthority: () => void) {
		return this.#storage.transactionSync(() => {
			SqliteWriterHost.#sync(validateAuthority());
			const source = this.source();
			const indexOptions = this.#indexOptions(true);
			const log = this.#log;
			const previous = this.#state.read("host", "adoption-root") as
				| { source: WriterSource; next: number; digest: string }
				| undefined;
			if (
				(from === 0 && previous) ||
				(from > 0 && (!previous || previous.next !== from || !SqliteWriterHost.#same(previous.source, source)))
			)
				throw new Error("writer adoption root cursor is stale");
			let digest = previous?.digest ?? "";
			const decoded = withDecodedFrames(
				this.#storage,
				`${this.#namespace}:decoded`,
				log,
				{ from, to: source.logLength, ...limits, digest },
				(frames) => {
					const result = Project.adoptWriterPage(
						this.#state,
						{
							source,
							from,
							frames,
							...limits,
							decodedFrames: true,
							currentSource: () => this.source(),
						},
						indexOptions,
					);
					return result;
				},
			);
			const result = decoded.result;
			digest = decoded.digest;
			SqliteWriterHost.#sync(validateAuthority());
			this.#state.write("host", "adoption-root", { source, next: result.next, digest });
			if (result.ready) {
				this.#state.write("host", "canonical", source);
				this.#state.write("host", "canonical-root", { format: 1, ...source, digest } satisfies WriterRoot);
			}
			return result;
		});
	}
	/** Read through the existing call adapter with persistent mutations forbidden. */
	readCalls<T>(input: {
		expected: WriterSource;
		validateAuthority(): void;
		services?: Pick<ProjectOptions, "hasBlob" | "whole">;
		operation(calls: EngineProject): T;
	}): T {
		return this.#storage.transactionSync(() => {
			SqliteWriterHost.#sync(input.validateAuthority());
			const source = this.source();
			this.root();
			if (!SqliteWriterHost.#same(input.expected, source)) throw new Error("reader source is stale");
			const refuse = () => {
				throw new Error("indexed read attempted to mutate persistent state");
			};
			const readOnly: GraphStateStorage = {
				read: (collection, key) => this.#state.read(collection, key),
				entries: (collection) => this.#state.entries(collection),
				write: refuse,
				remove: refuse,
				transaction: (body) => this.#storage.transactionSync(body),
			};
			const projection = this.#projection?.open({ state: this.#state, log: this.#log, root: this.root() });
			try {
				const project = Project.openWriter({ append: refuse }, readOnly, source.logLength, {
					...input.services,
					...(input.services?.whole ? { whole: { read: input.services.whole.read, keep: refuse } } : {}),
					readViewProvider: projection?.readViewProvider,
					entryAt: (index) => this.#log.since(index, 1)[0]!,
				});
				const root = this.root();
				const result = input.operation(
					new EngineProject(
						project,
						(from, limit) => this.#log.since(from, limit),
						undefined,
						this.#history
							? (at, operation) =>
									this.#history!.read(
										root,
										() => this.root(),
										input.validateAuthority,
										at,
										operation,
										projection?.historicalReadViewProvider,
									)
							: undefined,
					),
				);
				SqliteWriterHost.#sync(result);
				SqliteWriterHost.#sync(input.validateAuthority());
				if (!SqliteWriterHost.#same(source, this.source())) throw new Error("reader source changed");
				return result;
			} finally {
				SqliteWriterHost.#sync(projection?.close());
			}
		});
	}

	/** Reuse the existing call adapter within one fenced writer transaction. */
	runCalls<T>(input: {
		expected: WriterSource;
		validateAuthority(): void;
		checkerReady: boolean;
		services?: Pick<ProjectOptions, "hasBlob" | "whole">;
		operation(calls: EngineProject): T;
		commitReceipt(result: NoInfer<T>, source: WriterSource): void;
	}): T {
		return this.run({
			...input,
			operation: (project) => {
				const root = this.root();
				const calls = new EngineProject(
					project,
					(from, limit) => this.#log.since(from, limit),
					this.#log,
					this.#history
						? (at, operation) => this.#history!.read(root, () => this.root(), input.validateAuthority, at, operation)
						: undefined,
				);
				calls.setCheckerReady(input.checkerReady);
				return input.operation(calls);
			},
		});
	}
	/** No asynchronous gap is permitted between authority validation and commit. */
	run<T>(input: {
		expected: WriterSource;
		validateAuthority(): void;
		operation(project: Project): T;
		services?: Pick<ProjectOptions, "hasBlob" | "whole">;
		commitReceipt(result: NoInfer<T>, source: WriterSource): void;
	}): T {
		try {
			return this.#storage.transactionSync(() => {
				SqliteWriterHost.#sync(input.validateAuthority());
				const source = this.source();
				const root = this.root();
				const bound = this.#state.read("host", "canonical") as WriterSource | undefined;
				if (!SqliteWriterHost.#same(input.expected, source) || !SqliteWriterHost.#same(bound, source))
					throw new Error("writer source or adopted generation is stale");
				const projection = this.#projection?.open({ state: this.#state, log: this.#log, root });
				try {
					const project = Project.openWriter(this.#log, this.#state, source.logLength, {
						...input.services,
						...this.#indexOptions(),
						readViewProvider: projection?.readViewProvider,
						shapes: this.#log.shapes(),
						now: () => Date.now(),
					});
					const result = input.operation(project);
					SqliteWriterHost.#sync(result);
					SqliteWriterHost.#sync(input.validateAuthority());
					const committed = this.source();
					this.#state.write("host", "canonical", committed);
					const committedRoot = advanceWriterRoot(this.#log, root, committed);
					this.#state.write("host", "canonical-root", committedRoot);
					SqliteWriterHost.#sync(projection?.commit(project, committedRoot));
					this.#history?.advance(this.#log, root, committedRoot, () => this.root(), input.validateAuthority);
					SqliteWriterHost.#sync(input.commitReceipt(result, committed));
					return result;
				} finally {
					SqliteWriterHost.#sync(projection?.close());
				}
			});
		} catch (error) {
			// The Project was scoped to the transaction and is discarded. Restore
			// SqliteLog's cached sequence after an enclosing rollback as well.
			this.#log.refreshSequence();
			throw error;
		}
	}
}
