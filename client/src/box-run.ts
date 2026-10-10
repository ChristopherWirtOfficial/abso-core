// Running a command in the agent's box (abso run, logs, serve and prep): what those calls answer,
// and following a run's stream of JSON lines, reattaching by its id when the stream breaks.

import type { Api } from "./api.ts";
import { ApiError, errorSentence } from "./api-error.ts";

/** What POST /serve answers (abso serve). */
export interface ServeAnswer {
	readonly version: number;
	readonly url?: string;
	readonly built: boolean;
	readonly cached?: boolean;
	readonly files?: number;
	readonly bytes?: number;
	readonly seconds?: number;
	readonly exitCode?: number;
	readonly output?: string;
	readonly error?: string;
}

/** What abso prep's POST answers. */
export interface PrepAnswer {
	readonly error?: string;
	readonly exitCode?: number;
	readonly output?: string;
	readonly saved?: boolean;
	readonly snapshot?: string;
	readonly size?: number;
	readonly seconds?: number;
}

/** Where a run's output goes. */
/** What a box run is for (#39). */
export type RunKind = "run" | "shot" | "bisect" | "publish-check";

export interface RunIO {
	readonly out: (text: string) => void;
	/** The box's stderr, when the server keeps it apart; without this it goes to `out`. */
	readonly err?: (text: string) => void;
	readonly onReconnect?: (why: string, attempt: number) => void;
	readonly onRetry?: (why: string, attempt: number) => void;
	/** Stop the runs still going in the box first, instead of a 409 (abso run --replace). */
	readonly replace?: boolean;
	/** Called when the run starts: whether the box is fresh, and what X-Abso-Prep says about its prep. */
	readonly onBox?: (cold: boolean, prep: string | undefined) => void;
	/** Start from the plain image this once, not the prep (abso run --fresh). */
	readonly fresh?: boolean;
}

/** How far into a run's stdout (`at`) and stderr (`errAt`) the client has printed: the server's opaque offsets. */
export interface Seen {
	at: number;
	errAt: number;
}

/** A run stream the server ended early, saying the run goes on: reattach. */
class RunBroke extends Error {}

/** Waits before starting a run again when its connection failed before any answer (a trial saw about 1 in 20). */
export const RUN_START_RETRY_MS: readonly number[] = [500, 1500, 3000];

/** Waits between reconnect tries: about two minutes in all. */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000];

/**
 * Read one run stream, printing its output. Each out line's `at` is the
 * server's offset after it (opaque to the client), handed back on a reattach
 * so the server sends only what came after. Answers the exit code, or
 * undefined when the stream ended without one. Throws ApiError when the box
 * reports an error, and RunBroke (or the network's error) when the stream
 * breaks in a way a reattach recovers.
 */
export async function consumeRun(
	res: Response,
	io: Pick<RunIO, "out" | "err">,
	seen: Seen,
): Promise<number | undefined> {
	const decoder = new TextDecoder();
	let pending = "";
	let exit: number | undefined;
	const take = (line: string): void => {
		if (line.trim() === "") return;
		let msg: {
			out?: string;
			at?: number;
			err?: string;
			errAt?: number;
			exit?: number;
			error?: string;
			retry?: boolean;
		};
		try {
			msg = JSON.parse(line) as typeof msg;
		} catch {
			// Not one of ours: show it as output rather than drop it.
			io.out(`${line}\n`);
			return;
		}
		if (typeof msg.out === "string") {
			io.out(msg.out);
			if (typeof msg.at === "number") seen.at = msg.at;
		}
		if (typeof msg.err === "string") {
			(io.err ?? io.out)(msg.err);
			if (typeof msg.errAt === "number") seen.errAt = msg.errAt;
		}
		if (typeof msg.exit === "number") exit = msg.exit;
		if (typeof msg.error === "string") {
			// The server ends a stream it has to drop (a deploy) with retry: the run goes on in the box.
			if (msg.retry === true) throw new RunBroke(msg.error);
			throw new ApiError(`the box could not run the command: ${msg.error}`);
		}
		// Anything else ({"run"}, {"beat"}) only says the run is alive.
	};
	for await (const chunk of res.body!) {
		pending += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = pending.indexOf("\n")) >= 0) {
			take(pending.slice(0, nl));
			pending = pending.slice(nl + 1);
		}
	}
	take(pending + decoder.decode());
	return exit;
}
export function boxQuery(box: string | undefined): string {
	return box ? `&box=${encodeURIComponent(box)}` : "";
}

/** POST the run, starting again (same key) while no run id has come back. */
export async function postRun(
	api: Api,
	command: string,
	tarGz: Uint8Array<ArrayBuffer>,
	onRetry?: (why: string, attempt: number) => void,
	replace = false,
	fresh = false,
): Promise<Response> {
	// One key for every try of this run, so a server can tell a retry from a new run.
	const key = crypto.randomUUID();
	let res: Response | undefined;
	// When no run id came back, start again, a few times: the connection failed before the
	// server answered (ECONNRESET, "other side closed"), or something in front of the Worker
	// answered 5xx. The same key makes that safe: a server that did start the run follows it
	// instead of starting it again (5e34543). Once a run id arrives, the run is never started
	// again; a broken stream reattaches by its id instead.
	for (let attempt = 0; res === undefined; attempt++) {
		let why: string;
		let status: number | undefined;
		try {
			// stderr=split: the box's stderr comes apart from stdout (7a5a111); older servers ignore it.
			// replace=1: stop the runs still going in the box first; without it the server answers 409 (#25).
			const answer = await api.send(
				`${api.url(api.agentPath("run"))}?cmd=${encodeURIComponent(command)}&stderr=split${replace ? "&replace=1" : ""}${fresh ? "&fresh=1" : ""}${boxQuery(api.box)}`,
				{
					method: "POST",
					headers: { ...api.headers("application/gzip"), "x-abso-run-key": key, "x-abso-kind": api.runKind },
					body: tarGz,
				},
			);
			if (answer.status < 500 || answer.headers.get("x-abso-run") !== null) {
				res = answer;
				break;
			}
			status = answer.status;
			why = `run answered ${answer.status}: ${errorSentence(await answer.text())}`;
		} catch (err) {
			const e = err as Error;
			why = `could not reach ${api.config.server}: ${(e.cause as Error | undefined)?.message ?? e.message}`;
		}
		const delay = api.startRetryDelaysMs[attempt];
		if (delay === undefined) throw new ApiError(`${why}${attempt > 0 ? ` (tried ${attempt + 1} times)` : ""}`, status);
		onRetry?.(why, attempt + 1);
		await new Promise((ok) => setTimeout(ok, delay));
	}
	if (!res.ok || res.body === null) {
		throw new ApiError(`run answered ${res.status}: ${errorSentence(await res.text())}`, res.status);
	}
	return res;
}

export function followUrl(api: Api, id: string, seen: Seen): string {
	return `${api.url(`${api.agentPath("run")}/${encodeURIComponent(id)}`)}?from=${seen.at}&errFrom=${seen.errAt}${boxQuery(api.box)}`;
}

/** Print a run's stream until its exit line, reattaching by id when it breaks. */
export async function follow(api: Api, first: Response, id: string | null, seen: Seen, io: RunIO): Promise<number> {
	let res = first;
	for (let attempt = 0; ; attempt++) {
		let why: string;
		try {
			const exit = await consumeRun(res, io, seen);
			if (exit !== undefined) return exit;
			why = "the stream ended without an exit line";
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const e = err as Error;
			why = (e.cause as Error | undefined)?.message ?? e.message;
		}
		if (id === null) throw new ApiError(`the run broke off (${why}), and this server can't reattach to a run`);
		res = await reattach(api, id, seen, why, attempt, io.onReconnect);
	}
}

/** Wait, then ask for the run's output after what was seen; tries until RECONNECT_DELAYS_MS runs out. */
async function reattach(
	api: Api,
	id: string,
	seen: Seen,
	why: string,
	attempt: number,
	onReconnect?: (why: string, attempt: number) => void,
): Promise<Response> {
	let last = why;
	for (const delay of api.reconnectDelaysMs) {
		onReconnect?.(last, attempt + 1);
		await new Promise((ok) => setTimeout(ok, delay));
		try {
			const res = await api.send(followUrl(api, id, seen), { headers: api.headers() });
			if (res.status === 404)
				throw new ApiError(
					`the run broke off (${why}) and is gone from the box: ${errorSentence(await res.text())}`,
					404,
				);
			if (res.ok && res.body !== null) return res;
			last = `reconnect answered ${res.status}: ${errorSentence(await res.text())}`;
		} catch (err) {
			if (err instanceof ApiError) throw err;
			const e = err as Error;
			last = (e.cause as Error | undefined)?.message ?? e.message;
		}
	}
	throw new ApiError(
		`the run broke off (${why}) and reconnecting failed (${last}); it may still be running in the box (abso logs ${id} follows it)`,
	);
}
