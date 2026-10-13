// One project: its append-only log and blobs in the Durable Object's SQLite, the engine loaded from them, and the push
// out to the project's Artifacts repo after each new version of shared. Ported from the platform's ProjectObject
// (worker/src/index.ts), trimmed to the core path: no CI, merge queue checker, boxes, pipelines, members, visibility,
// R2 copies, edge cache, probes or disk-first writer.

import { DurableObject } from "cloudflare:workers";
import { type Answer, answer, type Readers } from "../../worker/project/http.ts";
import type { ProjectCalls, ProjectHistory } from "../../worker/project/project-api.ts";
import { BLOB_MAX, BlobStore } from "./blobs.ts";
import { DiskFirstRuntime } from "./disk-first-runtime.ts";
import { EngineProject, SqliteLog } from "./engine-project.ts";
import { artifactsOf, type Env } from "./env.ts";
import { pushedSince, remoteHead } from "./ingest.ts";
import {
	checkKey,
	emptyKeyState,
	expiresAt,
	hmac,
	issueKey,
	type KeyRole,
	type KeyState,
	keyAllows,
	listKeys,
	revokeKey,
} from "./keys.ts";
import { type PushResult, pushShared, repoName } from "./push.ts";
import { SqliteWriterState } from "./writer-host.ts";

const READ_OPS = new Set([
	"status",
	"blame",
	"why",
	"tree",
	"path",
	"follow",
	"collisions",
	"draft-state",
	"refusals",
	"labels",
	"log",
	"show",
	"file",
	"files",
	"compare",
	"where",
	"feed",
	"drafts",
	"diff",
	"ribbon",
	"position",
	"changes",
	"notes",
]);

/** At most one push out a minute: each one clones the repo, so publishes in a burst share one. */
export const PUSH_EVERY_MS = 60_000;
/** While agents are working, how often a call looks for plain-git pushes to the repo. */
const GIT_CHECK_MS = 15_000;

/**
 * The load guard (platform issue 46): an estimate of a loaded project's memory from its log entries, lines and claim
 * keys, all read from SQLite without loading. A Durable Object has 128 MB. Past the hard cap a project refuses to
 * load (export still reads it); past the soft cap, new work is held so the hard cap is never reached.
 */
const LOAD_BYTES_PER_ENTRY = 1_200;
const LOAD_BYTES_PER_LINE = 20;
const LOAD_BYTES_PER_KEY = 20;
const LOAD_BASE_BYTES = 10_000_000;
const LOAD_MAX_BYTES = 114_000_000;
const LOAD_SOFT_BYTES = 94_800_000;
/** Before its lines are counted, a log over this many characters refuses to load. */
const LOG_LOAD_MAX_CHARS = 12_000_000;
/** The ops the soft cap holds: the ones that bring new work into the history. */
const SOFT_HELD_OPS: ReadonlySet<string> = new Set(["record", "edit", "publish", "land", "amend", "pluck", "drop"]);

export function loadEstimate(entries: number, lines: number, keys: number): number {
	return entries * LOAD_BYTES_PER_ENTRY + lines * LOAD_BYTES_PER_LINE + keys * LOAD_BYTES_PER_KEY + LOAD_BASE_BYTES;
}

/** A presented agent key, checked inside the call so the check and the call are one trip. */
export interface KeyForCall {
	presented: string;
	address: string;
	write: boolean;
	route: string | undefined;
}

/** A news item from the issues code: delivered as an announcement from its writer. */
export interface IssueNews {
	from: string;
	issue: number | null;
	text: string;
	to?: string[];
}

/** What the issues Durable Object hears when a start note naming an issue begins and ends. Each is optional. */
interface IssueHooks {
	claim?(agent: string, issue: number, change: number): Promise<unknown>;
	unclaim?(agent: string, issue: number): Promise<unknown>;
	done?(agent: string, issue: number, version: number): Promise<unknown>;
}

export class ProjectObject extends DurableObject<Env> {
	private blobs: BlobStore;
	private loaded: ProjectCalls | undefined;
	/** Why the log didn't load, if it didn't. */
	private loadError: unknown;
	private tried = false;
	private authorityRevision = 0;
	/** Feed long-polls waiting for the log to grow; woken after every call that wrote. */
	private waiting: (() => void)[] = [];
	/** When this object last asked the repo for pushes made with plain git. */
	private gitCheckedAt = 0;
	private gitSyncing: Promise<{ head: string; commits: number; answer: unknown } | null> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.blobs = new BlobStore(ctx.storage);
	}

	/** Where files kept whole go: the project's blob store. */
	private wholeFiles() {
		return { keep: (text: string) => this.blobs.putText(text), read: (sha: string) => this.blobs.textOf(sha) };
	}

	private diskRuntime(): DiskFirstRuntime | undefined {
		return this.env.ABSO_DISK_FIRST === "on"
			? new DiskFirstRuntime(this.ctx.storage, this.ctx.id.toString(), "server-disk-v1", {
					hasBlob: (sha) => this.blobs.has(sha),
					whole: this.wholeFiles(),
				})
			: undefined;
	}
	private async prepareDisk(validate: () => void = () => {}) {
		const runtime = this.diskRuntime();
		if (!runtime) return undefined;
		const progress = runtime.preparePage(validate);
		if (!progress.ready && progress.phase !== "empty") await this.soon(Date.now() + 100);
		return progress;
	}
	/** Once indexing starts, legacy writes would invalidate the persistent root. */
	private legacyWritesHeld(): boolean {
		if (this.env.ABSO_DISK_FIRST === "on") return false;
		const tables = this.ctx.storage.sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writer_state'")
			.toArray();
		return (
			tables.length > 0 &&
			new SqliteWriterState(this.ctx.storage, "server-disk-v1").read("runtime", "format") !== undefined
		);
	}
	private useProject<T>(operation: (calls: EngineProject) => T, write = false): T {
		const runtime = this.diskRuntime();
		if (runtime) return write ? runtime.write(operation, () => {}) : runtime.read(operation, () => {});
		if (write && this.legacyWritesHeld())
			throw Error("disk-first indexes exist; enable ABSO_DISK_FIRST before writing");
		return operation(this.project as EngineProject);
	}
	private async diskCall(
		name: string,
		op: string,
		agent: string | undefined,
		body: unknown,
		how: string | undefined,
		revision: number,
	): Promise<Answer> {
		const runtime = this.diskRuntime()!;
		const validate = () => {
			if (revision !== this.authorityRevision)
				throw Object.assign(Error("project authorization changed during call setup"), { code: "authority-changed" });
		};
		const progress = await this.prepareDisk(validate);
		const known = new Set((await this.ctx.storage.get<string[]>("readers")) ?? []);
		validate();
		let readersChanged = false;
		const readers: Readers = {
			has: (a) => known.has(a),
			list: () => [...known].sort(),
			set: (a, on) => {
				if (on === known.has(a)) return;
				if (on) known.add(a);
				else known.delete(a);
				readersChanged = true;
			},
		};
		if (progress?.phase === "empty" && op !== "init")
			return { status: 404, body: { error: "no such project; run init first" } };
		if (!progress?.ready && !(progress?.phase === "empty" && op === "init"))
			return { status: 503, body: { error: "project indexes are being prepared", retryAfter: 1, progress } };
		const before = new SqliteLog(this.ctx.storage).seq();
		const action = (calls: EngineProject) => {
			const result = answer(calls, op, agent, body, readers, how);
			if (result.status >= 500) throw Error(`project operation failed: ${JSON.stringify(result.body)}`);
			return result;
		};

		const result =
			progress.phase === "empty"
				? runtime.initialize(action, validate)
				: READ_OPS.has(op) || op.startsWith("change/")
					? runtime.read(action, validate)
					: runtime.write(action, validate);
		if (readersChanged) {
			this.authorityRevision++;
			await this.ctx.storage.put("readers", readers.list());
		}
		const log = new SqliteLog(this.ctx.storage);
		if (log.seq() !== before) {
			this.wake();
			await this.ctx.storage.put("name", name);
			await this.soon(Date.now() + 100);
		}
		if (
			result.status === 200 &&
			artifactsOf(this.env) &&
			Date.now() - this.gitCheckedAt > GIT_CHECK_MS &&
			(await this.ctx.storage.get("name")) !== undefined &&
			(await this.ctx.storage.getAlarm()) === null
		)
			await this.ctx.storage.setAlarm(Date.now());
		if (result.status === 200 && op === "starting") result.body = await this.startingHooks(name, result.body);
		if (result.status === 200) result.body = this.withBlobSizes(op, result.body);
		return result;
	}

	/** The project, loaded from its log on first use. A log too big for memory is refused, not loaded. */
	private ensure(): ProjectCalls | undefined {
		if (this.diskRuntime()) throw Error("legacy project load forbidden in disk-first mode");
		if (this.loaded || this.tried) return this.loaded;
		this.tried = true;
		try {
			const why = this.tooBigToLoad();
			if (why) throw new Error(`${why}, too big to load in a Durable Object's memory; GET export still reads it`);
			this.loaded = EngineProject.open(this.ctx.storage, (sha) => this.blobs.has(sha), this.wholeFiles());
		} catch (e) {
			this.loadError = e;
		}
		return this.loaded;
	}

	private get project(): ProjectCalls {
		const p = this.ensure();
		if (!p) throw this.loadError;
		return p;
	}

	private logChars(): { chars: number; entries: number } {
		const tables = this.ctx.storage.sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'log'")
			.toArray();
		return tables.length === 0 ? { chars: 0, entries: 0 } : new SqliteLog(this.ctx.storage).logSize();
	}

	private sizes(): { lines: number; keys: number } | undefined {
		if (this.logChars().entries === 0) return undefined;
		try {
			return new SqliteLog(this.ctx.storage).countSizes();
		} catch {
			return undefined;
		}
	}

	/** Why recording new work is held: the estimate is past the soft cap; else null. */
	private softHeld(): string | null {
		const counted = this.sizes();
		if (counted === undefined) return null;
		const bytes = loadEstimate(this.logChars().entries, counted.lines, counted.keys);
		return bytes > LOAD_SOFT_BYTES
			? `this project is near the most a project can hold (an estimated ${(bytes / 1e6).toFixed(0)} MB of ${LOAD_MAX_BYTES / 1e6} MB), so recording and publishing are held; status and reads keep working`
			: null;
	}

	/** Why this project mustn't load: its estimated memory, or before its lines are counted, its log's size; else null. */
	private tooBigToLoad(): string | null {
		const counted = this.sizes();
		if (counted !== undefined) {
			const bytes = loadEstimate(this.logChars().entries, counted.lines, counted.keys);
			return bytes > LOAD_MAX_BYTES
				? `this project holds ${counted.lines} lines and ${this.logChars().entries} entries, an estimated ${(bytes / 1e6).toFixed(0)} MB once loaded`
				: null;
		}
		const { chars } = this.logChars();
		return chars > LOG_LOAD_MAX_CHARS ? `this project's log is ${(chars / 1e6).toFixed(1)} MB` : null;
	}

	// Blobs: binary files' bytes, named by their SHA-256.

	async putBlob(sha: string, body: ReadableStream<Uint8Array>): Promise<Answer> {
		const a = await this.blobs.put(sha, body);
		// A push out waiting on missing blobs goes again now.
		if (a.status === 200 && (await this.ctx.storage.get("pushError"))) await this.ctx.storage.setAlarm(Date.now());
		return a;
	}

	async getBlob(sha: string): Promise<ReadableStream<Uint8Array> | null> {
		return this.blobs.stream(sha);
	}

	/** Shared's newest version, from storage alone, never loading the project. Null when there's no project. */
	async head(): Promise<{ version: number; at: string } | null> {
		if (this.logChars().entries === 0) return null;
		return { version: new SqliteLog(this.ctx.storage).sharedVersion(), at: new Date().toISOString() };
	}

	/** Backups: one page of the log as JSON lines. It works even when the log won't load. */
	async exportLog(from: number, limit: number): Promise<{ lines: string; next: number | null } | null> {
		if (this.logChars().entries === 0) return null;
		const { texts, next } = new SqliteLog(this.ctx.storage).page(from, limit);
		return { lines: texts.map((t) => `${t}\n`).join(""), next };
	}

	private wake(): void {
		const all = this.waiting;
		this.waiting = [];
		for (const w of all) w();
	}

	/**
	 * GET feed?from=&wait=<seconds, up to 25>: when nothing is new, hold the call until an entry is written or the wait
	 * ends, then answer as usual.
	 */
	private async feed(name: string, body: unknown): Promise<Answer> {
		const q = (body ?? {}) as Record<string, string | undefined>;
		const wait = Math.min(25, Math.max(0, Number(q.wait) || 0));
		const first = await this.call(name, "feed", undefined, body, true);
		const from = Number(q.from) || 0;
		const empty = first.status === 200 && (first.body as { next: number }).next <= from;
		if (!empty || wait === 0) return first;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, wait * 1000);
			this.waiting.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		return this.call(name, "feed", undefined, body, true);
	}

	/** One project call: the agent key (if any), the size caps, then answer() from worker/project/http.ts. */
	async call(
		name: string,
		op: string,
		agent: string | undefined,
		body: unknown,
		inFeed = false,
		how?: string,
		key?: KeyForCall,
	): Promise<Answer> {
		const revision = this.authorityRevision;
		if (key) {
			const decided = await this.checkAgentKey(key.presented, agent, key.address);
			if (!decided.ok) return { status: decided.status, body: { error: decided.error } };
			const allowed = keyAllows(decided.role, { write: key.write, agent, route: key.route });
			if (!allowed.ok) return { status: allowed.status, body: { error: allowed.error } };
			how = decided.as;
		}
		if (op === "feed" && !inFeed) return this.feed(name, body);
		if (this.diskRuntime()) {
			try {
				return await this.diskCall(name, op, agent, body, how, revision);
			} catch (error) {
				if ((error as { code?: string })?.code === "authority-changed")
					return { status: 409, body: { error: "project authorization changed; retry the request", retryable: true } };
				throw error;
			}
		}
		if (this.legacyWritesHeld() && !READ_OPS.has(op) && !op.startsWith("change/"))
			return { status: 409, body: { error: "disk-first indexes exist; enable ABSO_DISK_FIRST before writing" } };
		if (SOFT_HELD_OPS.has(op)) {
			const held = this.softHeld();
			if (held) return { status: 507, body: { error: held } };
		}
		const loaded = this.ensure();
		if (!loaded) {
			const why = this.loadError instanceof Error ? this.loadError.message : String(this.loadError);
			return { status: 507, body: { error: `the project's log did not load: ${why}` } };
		}
		// Readers live in storage, not the log: a refused call writes nothing, so replay never needs them.
		const list = new Set((await this.ctx.storage.get<string[]>("readers")) ?? []);
		let changed = false;
		const readers: Readers = {
			has: (a) => list.has(a),
			set: (a, on) => {
				if (on === list.has(a)) return;
				if (on) list.add(a);
				else list.delete(a);
				changed = true;
			},
			list: () => [...list].sort(),
		};
		const before = loaded.exists() ? loaded.shared().version : -1;
		const logLength = () => (this.loaded as { logLength?: () => number } | undefined)?.logLength?.() ?? 0;
		const entriesBefore = logLength();
		const a = answer(loaded, op, agent, body, readers, how);
		if (changed) await this.ctx.storage.put("readers", readers.list());
		if (logLength() !== entriesBefore) this.wake();
		if (a.status === 200 && op === "starting") a.body = await this.startingHooks(name, a.body);
		if (a.status === 200) a.body = this.withBlobSizes(op, a.body);
		const after = loaded.exists() ? loaded.shared().version : -1;
		if (a.status === 200 && after >= 0 && (op === "init" || after > before)) {
			// A new version of shared: push it out to Artifacts in the background. The alarm retries; the call never waits.
			await this.ctx.storage.put("name", name);
			if (artifactsOf(this.env)) await this.ctx.storage.setAlarm(Date.now());
		} else if (
			a.status === 200 &&
			artifactsOf(this.env) &&
			Date.now() - this.gitCheckedAt > GIT_CHECK_MS &&
			(await this.ctx.storage.get("name")) !== undefined &&
			(await this.ctx.storage.getAlarm()) === null
		) {
			// While agents are working, the alarm also looks for plain-git pushes.
			await this.ctx.storage.setAlarm(Date.now());
		}
		return a;
	}

	/**
	 * The engine's starting answer carries hooks for the issues code (a start note naming an issue began or ended). They
	 * go to the project's IssueProject, and never to the client. A failed hook is logged and never fails the call.
	 */
	private async startingHooks(name: string, body: unknown): Promise<unknown> {
		const { hooks, ...rest } = body as {
			hooks?: {
				claim?: { issue: number; agent: string; change: number };
				unclaim?: { issue: number; agent: string; change: number; done?: boolean; version?: number };
			};
		};
		if (!hooks) return body;
		const issues = this.env.ISSUES_DO.get(this.env.ISSUES_DO.idFromName(name)) as unknown as IssueHooks;
		const tell = async (what: string, call: () => Promise<unknown> | undefined) => {
			try {
				await call();
			} catch (e) {
				console.log(JSON.stringify({ event: "issues-hook", what, project: name, error: String(e).slice(0, 200) }));
			}
		};
		const end = hooks.unclaim;
		if (end?.done && end.version !== undefined) {
			const version = end.version;
			await tell("done", () => issues.done?.(end.agent, end.issue, version));
		} else if (end) await tell("unclaim", () => issues.unclaim?.(end.agent, end.issue));
		const claim = hooks.claim;
		if (claim) await tell("claim", () => issues.claim?.(claim.agent, claim.issue, claim.change));
		return rest;
	}

	/** A folder's binary files count by their bytes, and a binary file says its size: the blob store knows both. */
	private withBlobSizes(op: string, body: unknown): unknown {
		if (op === "tree" && Array.isArray((body as { entries?: unknown }).entries)) {
			const b = body as { entries: { bytes?: number; blobs?: string[] }[] };
			return {
				...b,
				entries: b.entries.map(({ blobs, ...e }) =>
					blobs ? { ...e, bytes: (e.bytes ?? 0) + blobs.reduce((n, sha) => n + this.blobs.size(sha), 0) } : e,
				),
			};
		}
		if (op === "file" && typeof (body as { blob?: unknown }).blob === "string")
			return { ...(body as object), size: this.blobs.size((body as { blob: string }).blob) };
		return body;
	}

	// The push out to Artifacts, and plain-git pushes back in.

	/**
	 * Takes in commits pushed to the project's repo with plain git: the ones above the server's last commit that
	 * haven't been taken in yet. One run at a time; a call while a run is going gets that run's answer.
	 */
	gitSync(): Promise<{ head: string; commits: number; answer: unknown } | null> {
		this.gitSyncing ??= this.gitSyncOnce().finally(() => {
			this.gitSyncing = undefined;
		});
		return this.gitSyncing;
	}

	private async gitSyncOnce(): Promise<{ head: string; commits: number; answer: unknown } | null> {
		if (this.legacyWritesHeld()) return null;
		const artifacts = artifactsOf(this.env);
		if (!artifacts) return null;
		this.gitCheckedAt = Date.now();
		const name = await this.ctx.storage.get<string>("name");
		if (!name) return null;
		const progress = await this.prepareDisk();
		if (progress && !progress.ready) return null;
		if (!this.useProject((p) => p.exists())) return null;
		const seen = await this.ctx.storage.get<string>("git:head");
		const pushed = await this.ctx.storage.get<PushResult>("pushed");
		const head = await remoteHead(artifacts, name);
		if (!head || head === seen || head === pushed?.commit) return null;
		const sharedBlobs = this.useProject((p) => p.shared().blobs ?? {});
		const found = await pushedSince(
			artifacts,
			name,
			seen,
			async (bytes) => (bytes.byteLength > BLOB_MAX ? null : this.blobs.putBytes(bytes)),
			(path) => sharedBlobs[path],
		);
		if (!found || found.commits.length === 0) {
			if (found) await this.ctx.storage.put("git:head", found.head);
			return null;
		}
		let result: unknown;
		try {
			result = this.useProject(
				(p) => p.ingest({ author: found.author, base: found.base, commits: found.commits }, Date.now()),
				true,
			);
		} catch (e) {
			result = { error: e instanceof Error ? e.message : String(e) };
		}
		const taken = {
			at: new Date().toISOString(),
			head: found.head,
			commits: found.commits.length,
			answer: result,
			...(found.tooBig.length ? { tooBig: found.tooBig } : {}),
		};
		await this.ctx.storage.put({ "git:head": found.head, "git:last": taken });
		this.wake();
		if ((result as { landed?: boolean }).landed) await this.ctx.storage.setAlarm(Date.now());
		return taken;
	}

	/** Sets the alarm for `at` unless one is due sooner. */
	private async soon(at: number): Promise<void> {
		const now = await this.ctx.storage.getAlarm();
		if (now === null || now > at) await this.ctx.storage.setAlarm(at);
	}

	/**
	 * Plain-git pushes in first, so the push out builds on them; then shared out to the project's Artifacts repo, at
	 * most once a minute, backing off on failure. Without an ARTIFACTS binding (local dev) it does nothing.
	 */
	async alarm(): Promise<void> {
		if (!this.diskRuntime() && !artifactsOf(this.env)) return;
		if (!this.diskRuntime() && !this.ensure()) return;
		const progress = await this.prepareDisk();
		if (progress && !progress.ready) return;
		const artifacts = artifactsOf(this.env);
		if (!artifacts) return;
		const name = await this.ctx.storage.get<string>("name");
		if (!name || !this.useProject((p) => p.exists())) return;
		await this.gitSync().then(
			() => this.ctx.storage.delete("git:error"),
			(e) =>
				this.ctx.storage.put("git:error", {
					at: new Date().toISOString(),
					error: e instanceof Error ? e.message : String(e),
				}),
		);
		const shared = this.useProject((p) => p.shared());
		const done = await this.ctx.storage.get<PushResult>("pushed");
		if (done && done.version >= shared.version) return;
		const pushedAt = (await this.ctx.storage.get<number>("pushedAt")) ?? 0;
		if (Date.now() - pushedAt < PUSH_EVERY_MS) {
			await this.soon(pushedAt + PUSH_EVERY_MS);
			return;
		}
		let result: PushResult;
		try {
			result = await pushShared(artifacts, name, shared, (sha) => this.blobs.read(sha));
		} catch (e) {
			// Kept for /out, and tried again with a backoff of our own (a thrown alarm is retried only six times).
			const was = await this.ctx.storage.get<{ attempts?: number }>("pushError");
			const attempts = (was?.attempts ?? 0) + 1;
			await this.ctx.storage.put("pushError", {
				version: shared.version,
				at: new Date().toISOString(),
				attempts,
				error: e instanceof Error ? e.message : String(e),
			});
			await this.soon(Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 6)));
			return;
		}
		await this.ctx.storage.put({ pushed: result, "git:head": result.commit, pushedAt: Date.now() });
		await this.ctx.storage.delete("pushError");
		// Another publish may have landed while this push ran.
		if (this.useProject((p) => p.shared().version) > result.version) await this.soon(Date.now() + PUSH_EVERY_MS);
	}

	/** The push out: the repo, the last version pushed, and plain-git intake. */
	async out() {
		const name = await this.ctx.storage.get<string>("name");
		return {
			repo: name ? repoName(name) : null,
			artifacts: artifactsOf(this.env) ? "bound" : "unbound",
			version: this.logChars().entries ? new SqliteLog(this.ctx.storage).sharedVersion() : null,
			pushed: (await this.ctx.storage.get<PushResult>("pushed")) ?? null,
			error: (await this.ctx.storage.get("pushError")) ?? null,
			git: {
				head: (await this.ctx.storage.get<string>("git:head")) ?? null,
				last: (await this.ctx.storage.get("git:last")) ?? null,
				error: (await this.ctx.storage.get("git:error")) ?? null,
			},
		};
	}

	// Per-agent keys: the HMACs live here, one project's keys per object.

	private async keyState(): Promise<KeyState> {
		return (await this.ctx.storage.get<KeyState>("agent-keys")) ?? emptyKeyState();
	}

	async checkAgentKey(presented: string, agent: string | undefined, address: string) {
		const state = await this.keyState();
		const decided = await checkKey(state, this.env.KEY_HMAC_SECRET, presented, agent, Date.now(), address);
		if (decided.dirty) await this.ctx.storage.put("agent-keys", state);
		if (!decided.ok) return decided;
		const row = state.rows.find((r) => r.id === decided.id);
		return { ...decided, agent: row?.agent ?? "" };
	}

	/** Issues a key. The returned key is the only copy. */
	async issueAgentKey(
		agent: string,
		address: string,
		expiresRaw: string | null,
		role: KeyRole,
	): Promise<{ id: string; key: string; agent: string } | { error: string }> {
		const secret = this.env.KEY_HMAC_SECRET;
		if (!secret) return { error: "the key secret (KEY_HMAC_SECRET) is not set" };
		const when = expiresAt(Date.now(), expiresRaw);
		if (typeof when !== "number") return { error: when.error };
		const state = await this.keyState();
		const issued = await issueKey(state, secret, agent, "admin", Date.now(), address, when, role);
		this.authorityRevision++;
		await this.ctx.storage.put("agent-keys", state);
		return issued;
	}

	async revokeAgentKey(id: string, address: string): Promise<{ revoked: boolean }> {
		const secret = this.env.KEY_HMAC_SECRET;
		if (!secret) return { revoked: false };
		const state = await this.keyState();
		const revoked = revokeKey(state, id, Date.now(), await hmac(secret, address));
		this.authorityRevision++;
		await this.ctx.storage.put("agent-keys", state);
		return { revoked };
	}

	async listAgentKeys(agent?: string) {
		return listKeys(await this.keyState(), agent);
	}

	// For the issues code (server/src/issues/).

	/** The project's agent names, for the ask seat check. None when there's no project. */
	async agents(_project: string): Promise<string[]> {
		if (!this.diskRuntime() && !this.ensure()) return [];
		const progress = await this.prepareDisk();
		if (progress?.phase === "empty") return [];
		if (progress && !progress.ready) throw Error("project indexes are being prepared");
		return this.useProject((p) => (p.exists() ? p.status().agents.map((a) => a.agent) : []));
	}

	/**
	 * Issues news, delivered through the engine's announce path: each item goes to the agents whose start note names
	 * its issue and to the known agents in `to`, never back to its writer.
	 */
	async news(_project: string, items: IssueNews[]): Promise<{ to: string[] }[]> {
		if (!this.diskRuntime() && !this.ensure()) return items.map(() => ({ to: [] }));
		const progress = await this.prepareDisk();
		if (progress?.phase === "empty") return items.map(() => ({ to: [] }));
		if (progress && !progress.ready) throw Error("project indexes are being prepared");
		return this.useProject((p) => {
			if (!p.exists()) return items.map(() => ({ to: [] }));
			const engine = p as ProjectCalls & ProjectHistory;
			const out: { to: string[] }[] = [];
			for (const item of items) {
				const status = p.status() as { agents: { agent: string; starting?: { issue?: number } }[] };
				const known = new Set(status.agents.map((a) => a.agent));
				const to = new Set([
					...(item.issue !== null
						? status.agents.filter((a) => a.starting?.issue === item.issue).map((a) => a.agent)
						: []),
					...(item.to ?? []).filter((t) => known.has(t)),
				]);
				to.delete(item.from);
				if (to.size === 0) {
					out.push({ to: [] });
					continue;
				}
				try {
					engine.announce(item.from, item.text, [...to]);
					out.push({ to: [...to] });
				} catch (e) {
					// Persistent writer state may already have changed. Let the outer
					// transaction undo the whole batch before reporting a failure.
					if (this.env.ABSO_DISK_FIRST === "on") throw e;
					console.log(JSON.stringify({ event: "issues-news", error: String(e).slice(0, 200) }));
					out.push({ to: [] });
				}
			}
			this.wake();
			return out;
		}, true);
	}
}
