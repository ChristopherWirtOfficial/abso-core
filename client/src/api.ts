// Calls to the server's HTTP API (docs/v2-slice1.md). Every call is JSON
// except `run`, which sends a tar.gz and reads the answer as a stream of JSON
// lines (box-run.ts).

import { setDefaultResultOrder } from "node:dns";
import type {
	ChangeAnswer,
	DraftSyncAnswer,
	EditAnswer,
	EditBody,
	News,
	NoteAnswer,
	NoteBody,
	PublishAnswer,
	RecordAnswer,
	StatusAnswer,
	SwitchAnswer,
	SyncAnswer,
} from "./api-answers.ts";
import { ApiError, errorSentence, neverSent } from "./api-error.ts";
import {
	boxQuery,
	consumeRun,
	follow,
	followUrl,
	type PrepAnswer,
	postRun,
	RECONNECT_DELAYS_MS,
	RUN_START_RETRY_MS,
	type RunIO,
	type RunKind,
	type ServeAnswer,
} from "./box-run.ts";
import type { CiJob, CiStatus, QueueState } from "./ci-answers.ts";
import { clientVersion } from "./client-version.ts";
import type { Config } from "./config.ts";
import type {
	BlameAnswer,
	DiffAnswer,
	DropAnswer,
	FileChange,
	FilesAnswer,
	LogAnswer,
	Overlap,
	PluckAnswer,
	RestoreAnswer,
	ShowAnswer,
	View,
	Where,
	WhereAnswer,
	WhyAnswer,
} from "./history-answers.ts";
import type {
	Ask,
	Attachment,
	Draft,
	DraftBody,
	News as IssueNews,
	IssuePage,
	IssueRow,
	IssueSearchHit,
} from "./issues-wire.ts";
import type { Modes } from "./modes.ts";

export * from "./api-answers.ts";
export { ApiError, neverSent } from "./api-error.ts";
export {
	type PrepAnswer,
	RECONNECT_DELAYS_MS,
	RUN_START_RETRY_MS,
	type RunIO,
	type RunKind,
	type ServeAnswer,
} from "./box-run.ts";
export * from "./ci-answers.ts";
export * from "./history-answers.ts";
export type { Ask, Attachment, Draft, DraftBody, IssueNews, IssuePage, IssueRow, IssueSearchHit };

/**
 * How long a call may take: the base, plus 1 s for each 100 KB it sends
 * (abso issue 34: a sync that recorded 191 reformatted files first ran out of
 * its 30 s while the server was still taking them in).
 */
export function timeoutFor(baseMs: number, sent: string | undefined): number {
	return sent === undefined ? baseMs : baseMs + Math.floor(Buffer.byteLength(sent) / 100_000) * 1000;
}

/**
 * How long a publish or a land may take before the client stops waiting: the
 * server gives one request up to 2 minutes of work, so a small body can still
 * take that long (a large merge). Waiting less reported publishes as failed
 * that went on to land.
 */
export const PUBLISH_TIMEOUT_MS = 150_000;

/** The most versions the server's log sends at once. */
export const LOG_PAGE = 200;

/** A query string from the values that are set (null and undefined are left out). */
function query(values: Record<string, string | number | null | undefined>): URLSearchParams {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined) q.set(k, String(v));
	return q;
}

export function newsLines(news: News): string[] {
	if (news === undefined || news === null) return [];
	return (typeof news === "string" ? [news] : [...news]).filter((s) => typeof s === "string" && s.trim() !== "");
}

/** An issue copy's request: the source, and any texts given cleaned, by their source ids. */
export interface CopyBody {
	from: string;
	issue: number;
	title?: string;
	description?: string;
	comments?: { id: number; text?: string }[];
	asks?: { id: number; question?: string; answer?: string }[];
}

/** What a copy writes, as a dry run answers it. */
export interface CopyPlan {
	from: { project: string; issue: number };
	title: string;
	edited: ("title" | "description")[];
	labels: string[];
	closed: { how: "done" | "dropped" } | null;
	comments: { edited: boolean }[];
	asks: { edited: boolean }[];
	skipped: { comments: number[]; asks: number[] };
}

export type CopyAnswer =
	| { dryRun: true; plan: CopyPlan }
	| { ok: true; id: number; from: { project: string; issue: number }; skipped: { comments: number[]; asks: number[] } };

export class Api {
	readonly config: Config;
	readonly timeoutMs: number;

	/** Waits between tries when a run's stream breaks; tests shorten them. */
	readonly reconnectDelaysMs: readonly number[];
	readonly startRetryDelaysMs: readonly number[];
	/** Another box of this agent for run, logs and fetch (--box or ABSO_BOX, #37); undefined is its own box. */
	box: string | undefined;

	constructor(
		config: Config,
		timeoutMs = 30_000,
		reconnectDelaysMs: readonly number[] = RECONNECT_DELAYS_MS,
		startRetryDelaysMs: readonly number[] = RUN_START_RETRY_MS,
	) {
		this.config = config;
		this.timeoutMs = timeoutMs;
		this.reconnectDelaysMs = reconnectDelaysMs;
		this.startRetryDelaysMs = startRetryDelaysMs;
	}

	/** What a box run is for, for the server's box-run records (#39): X-Abso-Kind on POST /run. */
	runKind: RunKind = "run";

	/** The Issues Worker (#54) this folder's issues calls go to; set by the issues commands (issues.ts). */
	issuesServer: string | undefined;

	url(path: string, server = this.config.server): string {
		return `${server.replace(/\/+$/, "")}/p/${encodeURIComponent(this.config.project)}${path}`;
	}

	agentPath(action: string): string {
		return `/a/${encodeURIComponent(this.config.agent)}/${action}`;
	}

	headers(contentType?: string): Record<string, string> {
		return {
			// Which client made the call (#29); the mods send theirs too.
			"x-abso-client": `abso-cli/${clientVersion()}`,
			...(this.config.token && !this.config.visitor ? { authorization: `Bearer ${this.config.token}` } : {}),
			...(contentType ? { "content-type": contentType } : {}),
		};
	}

	async json<T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		server = this.config.server,
		atLeastMs = 0,
	): Promise<T> {
		let res: Response | undefined;
		// A visitor folder only reads, and follows no redirect, so nothing it sends goes anywhere it didn't name.
		const visitor = this.config.visitor === true;
		if (visitor && method !== "GET") throw new ApiError(`${path}: a folder that reads signed out sends only reads`);
		const sent = body === undefined ? undefined : JSON.stringify(body);
		const timeoutMs = Math.max(atLeastMs, timeoutFor(this.timeoutMs, sent));
		// A connection that never opened is tried once more, IPv4 first (#37, GAME - UI/UX: one IPv6
		// address timed out, and the same command went through seconds later). Nothing went out, so
		// a POST is as safe to send again as a GET.
		for (let attempt = 0; res === undefined; attempt++) {
			try {
				res = await fetch(this.url(path, server), {
					method,
					headers: this.headers(sent === undefined ? undefined : "application/json"),
					...(sent === undefined ? {} : { body: sent }),
					...(visitor ? { redirect: "error" as const, credentials: "omit" as const } : {}),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				const e = err as Error;
				const why =
					e.name === "TimeoutError"
						? `no answer within ${timeoutMs} ms`
						: ((e.cause as Error | undefined)?.message ?? e.message);
				if (!neverSent(err)) throw new ApiError(`could not reach ${server}: ${why}`);
				if (attempt >= 1) {
					throw new ApiError(
						`could not reach ${server}: ${why}. Tried twice, the second time IPv4 first; the connection never opened, so nothing reached the server`,
						undefined,
						true,
					);
				}
				setDefaultResultOrder("ipv4first");
				await new Promise((ok) => setTimeout(ok, 500));
			}
		}
		const text = await res.text();
		// 409 is a refusal that says what to do (a drop took out lines your work builds on): print it as it is.
		if (!res.ok)
			throw new ApiError(
				res.status === 409
					? `refused: ${errorSentence(text)}`
					: `${method} ${path} answered ${res.status}: ${errorSentence(text)}`,
				res.status,
			);
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new ApiError(
				`${method} ${path} answered with something that isn't JSON: ${text.slice(0, 300)}`,
				res.status,
			);
		}
	}

	init(
		files: Record<string, string>,
		modes: Modes = {},
		blobs: Readonly<Record<string, string>> = {},
	): Promise<{ version: number; skipped?: readonly string[] }> {
		return this.json("POST", "/init", {
			files,
			...(Object.keys(modes).length > 0 ? { modes } : {}),
			...(Object.keys(blobs).length > 0 ? { blobs } : {}),
		});
	}

	edit(body: EditBody): Promise<EditAnswer> {
		return this.json("POST", this.agentPath("edit"), body);
	}

	record(
		files: Record<string, string | null>,
		extra: { session?: string; subagent?: string } = {},
		modes: Modes = {},
		blobs: Readonly<Record<string, string>> = {},
	): Promise<RecordAnswer> {
		return this.json("POST", this.agentPath("record"), {
			files,
			...(Object.keys(modes).length > 0 ? { modes } : {}),
			...(Object.keys(blobs).length > 0 ? { blobs } : {}),
			...extra,
		});
	}

	/** Move a file in the draft (#49): its lines keep their ids. The way to change a file's case. */
	move(from: string, to: string): Promise<{ ok: boolean; from: string; to: string; news?: News }> {
		return this.json("POST", this.agentPath("move"), { from, to });
	}

	/** Upload a binary file's bytes under their sha256 (the server checks the hash). */
	async putBlob(sha: string, bytes: Uint8Array): Promise<void> {
		await this.bytes("PUT", `/blobs/${sha}`, bytes);
	}

	/** A preview of one version of shared at a stable URL (abso serve, #37); a build answers 422 with its output. */
	async serve(version?: number, cmd?: string, out?: string): Promise<ServeAnswer> {
		const q = new URLSearchParams({
			...(version !== undefined ? { version: String(version) } : {}),
			...(cmd ? { cmd } : {}),
			...(out ? { out } : {}),
		});
		let res: Response;
		try {
			res = await fetch(`${this.url("/serve")}?${q}`, {
				method: "POST",
				headers: this.headers(),
				signal: AbortSignal.timeout(20 * 60_000),
			});
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		const text = await res.text();
		if (!res.ok && res.status !== 422)
			throw new ApiError(`serve answered ${res.status}: ${errorSentence(text)}`, res.status);
		return JSON.parse(text) as ServeAnswer;
	}

	/** Runs a setup command on the folder in a fresh box and keeps the box as what it starts from (abso prep, #37). */
	async prep(command: string, tarGz: Uint8Array<ArrayBuffer>): Promise<PrepAnswer> {
		let res: Response;
		try {
			res = await fetch(`${this.url(this.agentPath("prep"))}?cmd=${encodeURIComponent(command)}${boxQuery(this.box)}`, {
				method: "POST",
				headers: this.headers("application/gzip"),
				body: tarGz,
				// A setup command can take minutes (npm ci, a browser download).
				signal: AbortSignal.timeout(30 * 60_000),
			});
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		const text = await res.text();
		if (!res.ok) throw new ApiError(`prep answered ${res.status}: ${errorSentence(text)}`, res.status);
		return JSON.parse(text) as PrepAnswer;
	}

	/** Forgets the box's prep: it starts from the plain image again. Answers whether it had one. */
	async unprep(): Promise<boolean> {
		let res: Response;
		try {
			res = await fetch(
				`${this.url(this.agentPath("prep"))}${this.box ? `?box=${encodeURIComponent(this.box)}` : ""}`,
				{ method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) },
			);
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		const text = await res.text();
		if (!res.ok) throw new ApiError(`prep answered ${res.status}: ${errorSentence(text)}`, res.status);
		return (JSON.parse(text) as { forgot: boolean }).forgot;
	}

	/** A binary file's bytes by their sha256. */
	/** A tar.gz of the files under the box's /w that match a glob (bash globstar); null when none match or the box has stopped. */
	async boxFiles(glob: string): Promise<Uint8Array | null> {
		try {
			return await this.bytes(
				"GET",
				`${this.agentPath("box-files")}?${new URLSearchParams({ glob, ...(this.box ? { box: this.box } : {}) })}`,
			);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) return null;
			throw err;
		}
	}

	getBlob(sha: string): Promise<Uint8Array> {
		return this.bytes("GET", `/blobs/${sha}`);
	}

	async bytes(method: "GET" | "PUT", path: string, body?: Uint8Array): Promise<Uint8Array> {
		let res: Response;
		try {
			res = await fetch(this.url(path), {
				method,
				headers: this.headers(body === undefined ? undefined : "application/octet-stream"),
				...(body === undefined ? {} : { body: body as Uint8Array<ArrayBuffer> }),
				signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
			});
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		const data = new Uint8Array(await res.arrayBuffer());
		if (!res.ok)
			throw new ApiError(
				`${method} ${path} answered ${res.status}: ${errorSentence(new TextDecoder().decode(data))}`,
				res.status,
			);
		return data;
	}

	/** Make this agent a reader, or not (#37): a reader's edits, records and publishes are refused. */
	reader(on: boolean): Promise<{ agent: string; reader: boolean }> {
		return this.json("POST", this.agentPath("reader"), { reader: on });
	}

	publish(message: string, asIs = false): Promise<PublishAnswer> {
		return this.json(
			"POST",
			this.agentPath("publish"),
			{ message, ...(asIs ? { asIs: true } : {}) },
			undefined,
			PUBLISH_TIMEOUT_MS,
		);
	}

	/** One change (#44). */
	change(id: number): Promise<ChangeAnswer> {
		return this.json("GET", `/change/${id}`);
	}

	/** The changes with anything new at or after log position `since`, newest first (#44). */
	/** Changes active since a log position, newest first; `older` is set when more come before the page (ask again with `before`). */
	changes(
		since: number,
		limit = 50,
		before?: number,
	): Promise<{ since: number; next: number; changes: readonly ChangeAnswer[]; older?: number }> {
		return this.json("GET", `/changes?${query({ since, limit, before })}`);
	}

	/** A call to the Issues Worker (#54), with the same token. */
	#issues<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		if (this.issuesServer === undefined)
			throw new ApiError(`${this.config.server} has no Issues Worker beside it; ABSO_ISSUES_SERVER names one`);
		return this.json(method, path, body, this.issuesServer);
	}

	/** Issues, most recently updated first. */
	issues(
		q: { status?: string; agent?: string; parent?: number; open?: boolean; labels?: readonly string[] } = {},
	): Promise<{ issues: readonly IssueRow[] }> {
		return this.#issues(
			"GET",
			`/issues?${query({ status: q.status, agent: q.agent, parent: q.parent, open: q.open ? 1 : undefined, label: q.labels && q.labels.length > 0 ? q.labels.join(",") : undefined })}`,
		);
	}

	/**
	 * The project's issues matching q, best first: by its words and, where
	 * the server has it on, by what it means.
	 */
	issueSearch(q: string, limit?: number): Promise<{ hits: readonly IssueSearchHit[] }> {
		return this.#issues("GET", `/search?${query({ q, limit })}`);
	}

	/** Every label in use, with how many issues have it and how many of those are open. */
	issueLabels(): Promise<{ labels: readonly { label: string; open: number; total: number }[] }> {
		return this.#issues("GET", "/labels");
	}

	issue(id: number): Promise<IssuePage> {
		return this.#issues("GET", `/issue/${id}`);
	}

	/** The asks this agent sent: the open ones, then the latest answered, each with its thread. */
	asked(): Promise<{ asks: readonly (Ask & { title: string | null })[] }> {
		return this.#issues("GET", this.agentPath("asked"));
	}

	/** One ask, open or closed, with its thread and who it waits on. */
	askThread(id: number): Promise<{ ask: Ask & { title: string | null } }> {
		return this.#issues("GET", `/ask/${id}`);
	}

	/** Open asks of someone (an agent, or person:<id>), soonest due first; every open ask without `of`. */
	waiting(of?: string): Promise<{ asks: readonly (Ask & { title: string | null })[] }> {
		return this.#issues("GET", `/waiting?${query({ of })}`);
	}

	/** This agent's open asks; the Worker marks each it lists for the first time as seen (abso issue 124). */
	async waitingMine(): Promise<{ asks: readonly (Ask & { title: string | null })[] }> {
		try {
			return await this.#issues("GET", this.agentPath("waiting"));
		} catch (err) {
			// An Issues Worker from before 124 has no /a/:agent/ reads.
			if (err instanceof ApiError && err.status === 404) return this.waiting(this.config.agent);
			throw err;
		}
	}

	issueOpen(body: DraftBody & { title: string; attachments?: string[] }): Promise<{ id: number; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath("issue"), body);
	}

	/** Uploads an image to the Issues Worker (abso issue 171): it checks the type by the bytes, strips metadata and answers its id. */
	async attachmentUpload(bytes: Uint8Array, name: string): Promise<Attachment> {
		if (this.issuesServer === undefined)
			throw new ApiError(`${this.config.server} has no Issues Worker beside it; ABSO_ISSUES_SERVER names one`);
		const path = this.agentPath("attachments");
		let res: Response;
		try {
			res = await fetch(this.url(path, this.issuesServer), {
				method: "POST",
				headers: { ...this.headers("application/octet-stream"), "x-abso-name": encodeURIComponent(name) },
				body: bytes as Uint8Array<ArrayBuffer>,
				signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
			});
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.issuesServer}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		const text = await res.text();
		// A server from before attachments has no upload route: it answers 404, or 400 because the body isn't JSON;
		// one with the route but nowhere to keep files answers 501. Say so plainly, and that nothing was sent.
		if (res.status === 404 || res.status === 501 || (res.status === 400 && /the body is JSON/.test(text)))
			throw new ApiError(
				`${this.issuesServer} doesn't take attachments yet, so ${name} wasn't sent and nothing was written. Leave --attach off, or link the image instead.`,
				res.status,
			);
		if (!res.ok) throw new ApiError(`uploading ${name} answered ${res.status}: ${errorSentence(text)}`, res.status);
		return JSON.parse(text) as Attachment;
	}

	/**
	 * Copies issue `body.issue` of this project into project `to`, keeping
	 * authors and times: the Issues server reads the source itself, and only
	 * texts may be given cleaned. A dry run answers the plan and writes nothing.
	 */
	issueCopy(to: string, body: CopyBody & { dryRun?: boolean }): Promise<CopyAnswer> {
		const there = new Api({ ...this.config, project: to }, this.timeoutMs);
		there.issuesServer = this.issuesServer;
		return there.#issues("POST", there.agentPath("copy"), body);
	}

	/** Where an attachment is served. */
	attachmentUrl(id: string): string {
		return this.url(`/attachments/${id}`, this.issuesServer);
	}

	/** An attachment's bytes, or with `source` the svg it was drawn from; refused past `max` bytes. */
	async attachmentBytes(id: string, source: boolean, max: number): Promise<Uint8Array> {
		if (this.issuesServer === undefined)
			throw new ApiError(`${this.config.server} has no Issues Worker beside it; ABSO_ISSUES_SERVER names one`);
		const url = `${this.attachmentUrl(id)}${source ? "/source" : ""}`;
		let res: Response;
		try {
			res = await fetch(url, {
				headers: this.headers(),
				signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
			});
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.issuesServer}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		if (!res.ok) throw new ApiError(`${url} answered ${res.status}: ${errorSentence(await res.text())}`, res.status);
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length > max) throw new ApiError(`${url} sent ${bytes.length} bytes, more than an attachment may be`);
		return bytes;
	}

	/** An edit (abso issue 3): it tells the issue's watchers, and `also`, unless `notify` is false. null clears a parent or Agent. */
	issueEdit(
		id: number,
		body: {
			title?: string;
			description?: string;
			parent?: number | null;
			agent?: string | null;
			blockedBy?: number[];
			notify?: boolean;
			also?: string[];
			addLabels?: string[];
			removeLabels?: string[];
		},
	): Promise<{ edit: number; notified: readonly string[]; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`issue/${id}/edit`), body);
	}

	issueComment(
		id: number,
		text: string,
		objection = false,
		attachments: readonly string[] = [],
	): Promise<{ id: number; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`issue/${id}/comment`), {
			text,
			...(objection ? { objection } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
		});
	}

	issueDrop(id: number): Promise<{ news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`issue/${id}/drop`), {});
	}

	/** Opens a dropped issue again (abso issue 104). */
	issueReopen(id: number): Promise<{ news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`issue/${id}/reopen`), {});
	}

	/** Marks an issue done by hand (abso issue 38). `version` is the publish that did it, when there is one. */
	issueDone(id: number, version: number | null): Promise<{ news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`issue/${id}/done`), { ...(version !== null ? { version } : {}) });
	}

	/** This agent's drafts (abso issue 3): its own, with no number and no news, newest first. */
	drafts(): Promise<{ drafts: readonly Draft[] }> {
		return this.#issues("GET", this.agentPath("drafts"));
	}

	/** Saves a draft, new or (with id) over one of this agent's: the body replaces the draft's. */
	saveDraft(body: DraftBody & { id?: number }): Promise<{ id: number }> {
		return this.#issues("POST", this.agentPath("draft"), body);
	}

	/** Opens a draft as an issue, `body`'s fields over the draft's, and deletes the draft. */
	openDraft(id: number, body: DraftBody = {}): Promise<{ id: number; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`draft/${id}/open`), body);
	}

	deleteDraft(id: number): Promise<{ ok: boolean }> {
		return this.#issues("POST", this.agentPath(`draft/${id}/delete`), {});
	}

	ask(body: {
		issue?: number;
		of: string;
		question: string;
		review?: boolean;
		kind?: "question" | "task";
		due?: string;
		blocks?: number[];
		options?: string[];
		attachments?: string[];
	}): Promise<{ id: number; news?: IssueNews; attachments?: string[] }> {
		return this.#issues("POST", this.agentPath("ask"), body);
	}

	answer(
		id: number,
		body: { words?: string; option?: number | string; note?: string; done?: boolean; attachments?: string[] },
	): Promise<{ ask: Ask; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`answer/${id}`), body);
	}

	/** Acknowledges an ask of this agent without answering it: the asker hears it, and the ask stays open. */
	ack(id: number, body: { note?: string }): Promise<{ ask: Ask; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`ack/${id}`), body);
	}

	/** Adds to an ask's thread, as its asker or the one asked; the other side hears it, and the ask stays as it is. */
	reply(id: number, body: { text: string; question?: boolean }): Promise<{ ask: Ask; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`reply/${id}`), body);
	}

	/** Takes back an ask this agent made, with a note on why; the one asked hears it. */
	withdraw(id: number, body: { note?: string }): Promise<{ ask: Ask; news?: IssueNews }> {
		return this.#issues("POST", this.agentPath(`withdraw/${id}`), body);
	}

	/** Notes on lines (#44), by file or change; open ones only with `open`. */
	notes(q: { file?: string; change?: number; open?: boolean } = {}): Promise<{ notes: readonly NoteAnswer[] }> {
		return this.json("GET", `/notes?${query({ file: q.file, change: q.change, open: q.open ? 1 : undefined })}`);
	}

	note(body: NoteBody): Promise<{ id: number; change: number | null; lines: readonly [number, number] }> {
		return this.json("POST", this.agentPath("note"), body);
	}

	noteClose(id: number, how: "resolved" | "withdrawn"): Promise<unknown> {
		return this.json("POST", this.agentPath("note-close"), { id, how });
	}

	/** The merge queue now (#39). */
	queueState(): Promise<QueueState> {
		return this.json("GET", "/queue");
	}

	/** The project's visibility (abso issue 152): public or private. */
	visibility(): Promise<{ project: string; visibility: "public" | "private" }> {
		return this.json("GET", "/visibility");
	}

	/** Switch the project's visibility (abso issue 140): an owner's key, or the shared token on staging. */
	setVisibility(v: "public" | "private"): Promise<{ project: string; visibility: "public" | "private" }> {
		return this.json("POST", `/visibility?visibility=${v}`, {});
	}

	/** Take back this agent's queued publishes (#39); refused while one is being checked. */
	unqueue(): Promise<{ pulled: readonly number[] }> {
		return this.json("POST", this.agentPath("unqueue"), {});
	}

	/**
	 * Sync; a folder following a label goes to the newest version with that label.
	 * With `full`, the answer holds every file in the agent's view, as a first sync's does,
	 * not only what changed since its last sync (#37: a join for an agent the server knew).
	 */
	sync(options: { full?: boolean } = {}): Promise<SyncAnswer> {
		return this.json("POST", this.agentPath("sync"), {
			...(this.config.follow ? { label: this.config.follow } : {}),
			...(options.full ? { full: true } : {}),
		});
	}

	/** Take published versions back out of shared (with the versions that build on them, when asked). */
	drop(versions: readonly number[], message: string, withDependents = false): Promise<DropAnswer> {
		return this.json("POST", this.agentPath("drop"), {
			versions,
			message,
			...(withDependents ? { withDependents: true } : {}),
		});
	}

	/** Take some versions of a named draft into shared, as one version. */
	pluck(draft: string, versions: readonly number[], message: string, withDependencies = false): Promise<PluckAnswer> {
		return this.json("POST", this.agentPath("pluck"), {
			draft,
			versions,
			message,
			...(withDependencies ? { withDependencies: true } : {}),
		});
	}

	/** Correct the message of this agent's newest publish in its space. */
	amend(message: string): Promise<{ version: number; draft: string | null; message: string; was: string }> {
		return this.json("POST", this.agentPath("amend"), { message });
	}

	/** Put a label on a version of shared (the newest by default), or take it off. */
	label(
		name: string,
		version?: number,
		remove = false,
	): Promise<{ name: string; version: number; versions: readonly number[] }> {
		return this.json("POST", this.agentPath("label"), {
			name,
			...(version === undefined ? {} : { version }),
			...(remove ? { remove: true } : {}),
		});
	}

	labels(): Promise<{ labels: Readonly<Record<string, readonly number[]>> }> {
		return this.json("GET", "/labels");
	}

	status(): Promise<StatusAnswer> {
		return this.json("GET", "/status");
	}

	/** The status and the paths in the agent's view, in one trip (abso issue 80). */
	async statusAndFiles(): Promise<StatusAnswer & { files: FilesAnswer | undefined }> {
		try {
			return await this.json("GET", this.agentPath("status"));
		} catch (err) {
			// A server from before it has no /a/:agent/status; the listing itself is from #37.
			if (!(err instanceof ApiError && err.status === 404)) throw err;
		}
		const status = await this.status();
		return { ...status, files: await this.viewFiles().catch(() => undefined) };
	}

	/** CI's state (#39), or one version's job. */
	ci(): Promise<CiStatus>;
	ci(version: number): Promise<CiJob>;
	ci(version?: number): Promise<CiStatus | CiJob> {
		return this.json("GET", version === undefined ? "/ci" : `/ci?${query({ version })}`);
	}

	/** The project's pipeline runs, newest first; one run with its jobs; or one job's log (`log` is pipeline.job). */
	pipelineRuns(run?: number, log?: string): Promise<unknown> {
		return this.json("GET", run === undefined ? "/pipelines" : `/pipelines?${query({ run, log })}`);
	}

	/** Ends every /latest link handed out so far; answers CI's state with the new link. */
	ciRevoke(): Promise<CiStatus> {
		return this.json("POST", "/ci/revoke", {});
	}

	/** Count versions up to `through` as seen by CI and end any red or bisect, so an import's history isn't checked (#56). */
	ciSkip(through: number): Promise<unknown> {
		return this.json("POST", "/ci/skip", { through });
	}

	/** Move to a named draft (null: shared). With carry, the current unpublished changes start a new draft. */
	switchDraft(name: string | null, carry = false): Promise<SwitchAnswer> {
		return this.json("POST", this.agentPath("draft"), { name, ...(carry ? { carry: true } : {}) });
	}

	/** Land never queues: with the merge queue on, the server refuses it (#39). */
	land(message: string): Promise<Exclude<PublishAnswer, { queued: number }>> {
		return this.json("POST", this.agentPath("land"), { message }, undefined, PUBLISH_TIMEOUT_MS);
	}

	draftSync(): Promise<DraftSyncAnswer> {
		return this.json("POST", this.agentPath("draft-sync"), {});
	}

	blame(file: string, from?: number, to?: number, version?: number, view: View = {}): Promise<BlameAnswer> {
		return this.json("GET", `/blame?${query({ file, from, to, version, ...view })}`);
	}

	/** The paths in the agent's view: what its folder should hold (#37). */
	viewFiles(): Promise<FilesAnswer> {
		return this.json("GET", this.agentPath("files"));
	}

	/** The paths in shared, or a named draft, at a version (the newest by default). */
	filesAt(draft: string | null, version?: number): Promise<FilesAnswer> {
		return this.json("GET", `/files?${query({ draft, version })}`);
	}

	/** The versions of a space, newest first; with `path`, only those that changed it. */
	/**
	 * The versions newest first, below `before` when it's given. The server
	 * sends at most LOG_PAGE at a time, so a longer log is read page by page,
	 * following each page's next. `next` on the answer says older ones are left.
	 */
	async log(where: Where, limit?: number, path?: string, before?: number): Promise<LogAnswer> {
		let page = await this.#logPage(where, limit === undefined ? undefined : Math.min(limit, LOG_PAGE), path, before);
		const versions = [...page.versions];
		while (limit !== undefined && versions.length < limit && page.next !== undefined) {
			page = await this.#logPage(where, Math.min(limit - versions.length, LOG_PAGE), path, page.next);
			versions.push(...page.versions);
		}
		const { next, ...rest } = page;
		return { ...rest, versions, ...(next !== undefined ? { next } : {}) };
	}

	#logPage(
		where: Where,
		limit: number | undefined,
		path: string | undefined,
		before: number | undefined,
	): Promise<LogAnswer> {
		return this.json("GET", `/log?${query({ ...where, limit, path, before })}`);
	}

	show(version: number, where: Where): Promise<ShowAnswer> {
		return this.json("GET", `/show?${query({ version, ...where })}`);
	}

	fileAt(path: string, version: number, where: Where): Promise<{ path: string; version: number; text: string | null }> {
		return this.json("GET", `/file?${query({ path, version, ...where })}`);
	}

	compare(from: number, to: number, where: Where): Promise<{ from: number; to: number; files: readonly FileChange[] }> {
		return this.json("GET", `/compare?${query({ from, to, ...where })}`);
	}

	/** A message to the project's other agents (or those named), delivered once as news. */
	starting(
		text: string | null,
		files?: readonly string[],
		options: { issue?: number; done?: boolean } = {},
	): Promise<{
		starting: { text: string; files: readonly string[]; time: number; issue?: number } | null;
		overlaps: readonly Overlap[];
	}> {
		return this.json("POST", this.agentPath("starting"), {
			text,
			...(files && files.length > 0 ? { files } : {}),
			...(options.issue !== undefined ? { issue: options.issue } : {}),
			...(options.done ? { done: true } : {}),
		});
	}

	announce(text: string, to?: readonly string[]): Promise<{ id: number; to: readonly string[] }> {
		return this.json("POST", this.agentPath("announce"), { text, ...(to ? { to } : {}) });
	}

	/** The news waiting for this agent, handed over once. */
	news(): Promise<{ news: News; items?: readonly { readonly text: string; readonly at: number | null }[] }> {
		return this.json("POST", this.agentPath("news"), {});
	}

	/** This agent's unpublished changes, file by file. */
	diff(): Promise<DiffAnswer> {
		return this.json("POST", this.agentPath("diff"), {});
	}

	/** Another agent's recorded, unpublished changes, file by file: read only, as the website's drafts show them. */
	diffOf(agent: string): Promise<DiffAnswer> {
		return this.json("GET", `/diff?${query({ agent })}`);
	}

	/** Discard this agent's unpublished changes to `files` (null: all of them). */
	restore(files: readonly string[] | null): Promise<RestoreAnswer> {
		return this.json("POST", this.agentPath("restore"), files === null ? { all: true } : { files });
	}

	why(file: string, line: number, view: View = {}): Promise<WhyAnswer> {
		return this.json("GET", `/why?${query({ file, line, ...view })}`);
	}

	where(): Promise<WhereAnswer> {
		return this.json("GET", "/where");
	}

	/**
	 * Send the folder as a tar.gz and run a command in the agent's box. Output
	 * goes to `io.out` as it arrives, and the box's stderr to `io.err` (the
	 * server keeps them apart when asked; an older one sends both as out).
	 * Answers the command's exit code.
	 *
	 * When the stream breaks before the exit line and the server gave the run
	 * an id, the run goes on in the box: this reconnects to it and carries on
	 * from the last output printed, so nothing is lost or printed twice. The
	 * command itself is never sent twice.
	 */
	async run(command: string, tarGz: Uint8Array<ArrayBuffer>, io: RunIO): Promise<number> {
		const res = await postRun(this, command, tarGz, io.onRetry, io.replace, io.fresh);
		// X-Abso-Box: cold means the box started for this run; X-Abso-Prep says whether it started from the prep (#37).
		io.onBox?.(res.headers.get("x-abso-box") === "cold", res.headers.get("x-abso-prep") ?? undefined);
		return follow(this, res, res.headers.get("x-abso-run"), { at: 0, errAt: 0 }, io);
	}

	/**
	 * Start a run and answer its id without waiting: the job goes on in the box
	 * after this connection closes (abso run --detach; abso logs <id> follows it).
	 */
	async startRun(
		command: string,
		tarGz: Uint8Array<ArrayBuffer>,
		onRetry?: (why: string, attempt: number) => void,
		replace = false,
	): Promise<string> {
		const res = await postRun(this, command, tarGz, onRetry, replace);
		const id = res.headers.get("x-abso-run");
		if (id === null) {
			// No id: the box failed before the job started ({"error"} in the body), or the server can't detach.
			await consumeRun(res, { out: () => {} }, { at: 0, errAt: 0 });
			throw new ApiError("this server gives runs no id, so a run can't be detached");
		}
		await res.body?.cancel();
		return id;
	}

	/** A run's output from its start, for as long as the box keeps it, until it ends (abso logs). Answers its exit code. */
	async logs(id: string, io: RunIO): Promise<number> {
		let res: Response;
		try {
			res = await fetch(followUrl(this, id, { at: 0, errAt: 0 }), { headers: this.headers() });
		} catch (err) {
			const e = err as Error;
			throw new ApiError(
				`could not reach ${this.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`,
			);
		}
		if (res.status === 404) throw new ApiError(`no run ${id} in this box: ${errorSentence(await res.text())}`, 404);
		if (!res.ok || res.body === null)
			throw new ApiError(`logs answered ${res.status}: ${errorSentence(await res.text())}`, res.status);
		return follow(this, res, id, { at: 0, errAt: 0 }, io);
	}
}
