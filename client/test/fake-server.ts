// A local stand-in for the avcs Worker, for testing the client. The project
// logic is the real engine (worker/project/project.ts, in memory) with the
// Worker's own blame, why and where; only the HTTP routing (as in
// worker/project/http.ts) and the box are local. `run` unpacks the folder into a
// temp folder and runs the command there.
//
// Run it on its own to point a real folder at it:
//   node client/test/fake-server.ts [port]

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { blame, why } from "../../worker/project/blame.ts";
import { readerAnswer, statusWithReaders } from "../../worker/project/http.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { type Candidate, type CheckResult, queueRound } from "../../worker/project/queue-driver.ts";
import { where } from "../../worker/project/where.ts";
import { globTest } from "../src/at.ts";
import { tarGz } from "../src/tar.ts";

/** Exit codes from 0xC0000000 up are Windows exceptions (0xC0000005: an access violation): the process crashed. */
const WINDOWS_CRASH = 0xc0000000;

interface Hosted {
	readonly project: Project;
	readonly store: MemoryStore;
	/** Every edit and record body, by agent, for tests. */
	readonly calls: Map<string, { action: string; body: unknown }[]>;
	box: string | undefined;
	/** Runs by id: their output so far, the exit line once known, and who is listening. */
	readonly runs: Map<string, Run>;
	/** Binary files' bytes by sha256, as the Worker's blob store keeps them. */
	readonly blobs: Map<string, Buffer>;
	/** Agents that read and never record (#37), kept outside the log as the Worker keeps them. */
	readers?: Set<string>;
	/** CI (#39), as a test sets it: status's ci, each shared version's log mark, and the jobs GET /ci?version=N answers. */
	ci?: FakeCi;
	/** The merge queue (#39): the last round, and whether one is running. */
	queueLast?: Record<string, unknown> | null;
	queueBusy?: boolean;
}

export interface FakeCi {
	status: Record<string, unknown>;
	marks: Map<number, string>;
	jobs: Map<number, Record<string, unknown>>;
}

interface Run {
	/** The output so far; `at` offsets count its bytes, as the Worker's do. */
	out: Buffer;
	/** The stderr so far, when the run keeps it apart (?stderr=split); `errAt` counts its bytes. */
	err: Buffer;
	readonly split: boolean;
	end: string | undefined;
	readonly listeners: Set<(line: string) => void>;
}

export interface Fake {
	readonly url: string;
	readonly projects: Map<string, Hosted>;
	/** The token every request must carry, as the Worker's AVCS_TOKEN. */
	readonly token: string;
	/** Added to every answer, to stand in for the network. */
	delayMs: number;
	/** How many of the next run streams (the POST or a reattach) to cut after their first output line, as a dropped connection. */
	cutRunStreams: number;
	/** How a cut stream ends: dropped, or with the Worker's {"error", "retry": true} (as a deploy ends one). */
	cutRunAs: "drop" | "retry";
	/** How many of the next run POSTs to drop before answering (ECONNRESET / "other side closed"); no run starts. */
	dropRunStarts: number;
	/** How the dropped ones end: the connection cut, or a 502 with no run id (as Cloudflare answers when the Worker fails). */
	dropRunAs: "reset" | 502;
	/**
	 * Paths the next sync answer carries on top of the engine's, as a server
	 * that lets anything through would (the engine refuses them since 03a44da).
	 */
	injectSync:
		| { files?: Record<string, string | null>; modes?: Record<string, { exec?: boolean; link?: string | null }> }
		| undefined;
	/** Entries box-files adds to its answer, as a box holding hostile paths or links would. */
	boxExtra: { path: string; data: Uint8Array; link?: string }[] | undefined;
	/** While true, the merge queue runs no rounds (a test holds a publish in the queue). */
	queueHold: boolean;
	/** The next publish: commit it and answer 500 ('after'), or answer 500 without it ('before'), as a storage reset does. */
	failPublish: "after" | "before" | undefined;
	/** Run the merge queue's rounds now (after queueHold is let go). */
	kickQueue(name: string): Promise<void>;
	/** Each run POST's X-Abso-Run-Key, and whether a run started for it. */
	runStarts: { key: string | undefined; started: boolean; cmd: string; kind?: string }[];
	close(): Promise<void>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function isLocal(path: string): boolean {
	return [".abso", ".avcs"].some((d) => path === d || path.startsWith(`${d}/`) || path.startsWith(`./${d}/`));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Read a ustar archive (with pax path records) into path -> bytes. */
export function untar(data: Uint8Array): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	const text = (from: number, len: number): string =>
		new TextDecoder().decode(data.subarray(from, from + len)).replace(/\0.*$/s, "");
	let at = 0;
	let paxPath: string | undefined;
	while (at + 512 <= data.length) {
		if (data.subarray(at, at + 512).every((b) => b === 0)) break;
		const name = text(at, 100);
		const size = parseInt(text(at + 124, 12).trim() || "0", 8);
		const type = text(at + 156, 1);
		const prefix = text(at + 345, 155);
		const body = data.subarray(at + 512, at + 512 + size);
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
			paxPath = m?.[1];
			continue;
		}
		if (type === "0" || type === "") out.set(paxPath ?? (prefix ? `${prefix}/${name}` : name), body);
		paxPath = undefined;
	}
	return out;
}

export async function startFake(port = 0, token = "fake-token"): Promise<Fake> {
	const projects = new Map<string, Hosted>();
	const fake: Fake = {
		url: "",
		projects,
		token,
		delayMs: 0,
		cutRunStreams: 0,
		cutRunAs: "drop",
		dropRunStarts: 0,
		dropRunAs: "reset",
		runStarts: [],
		injectSync: undefined,
		boxExtra: undefined,
		queueHold: false,
		failPublish: undefined,
		kickQueue: async () => {},
		close: async () => {},
	};

	/** The queue's check, as the Worker's CI box runs it: the candidate's avcs.json build and check, in a folder of its files. */
	const queueCheck = async (c: Candidate): Promise<CheckResult> => {
		const dir = mkdtempSync(join(tmpdir(), "avcs-fake-queue-"));
		try {
			for (const [path, text] of Object.entries(c.files)) {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), text);
			}
			const cfg = JSON.parse(c.files["avcs.json"] ?? "{}") as { build?: string; check?: string };
			const cmd = [cfg.build, cfg.check].filter((s) => typeof s === "string" && s !== "").join(" && ");
			if (cmd === "") return { kind: "fail", output: "the merge queue needs a check (or a build) in avcs.json" };
			let r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8" });
			// As for box runs: a Windows crash at start, with nothing printed, runs once more.
			if ((r.status ?? 0) >= WINDOWS_CRASH && `${r.stdout ?? ""}${r.stderr ?? ""}` === "")
				r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8" });
			return r.status === 0 ? { kind: "pass" } : { kind: "fail", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	/** Rounds until the queue is empty, one at a time, as the Worker's object runs them. */
	fake.kickQueue = async (name: string): Promise<void> => {
		const hosted = projects.get(name);
		if (!hosted || hosted.queueBusy || fake.queueHold) return;
		hosted.queueBusy = true;
		try {
			while (hosted.project.queue().items.length > 0 && !fake.queueHold) {
				const round = await queueRound(hosted.project, { check: queueCheck });
				hosted.queueLast = { ...round, at: new Date().toISOString() };
				if (round.kind !== "landed" && round.kind !== "pulled") break;
			}
		} finally {
			hosted.queueBusy = false;
		}
	};
	const queueState = (hosted: Hosted) => ({
		items: hosted.project.queue().items,
		checking: hosted.queueBusy ?? false,
		paused: null,
		last: hosted.queueLast ?? null,
	});
	let runs = 0;
	// Blobs come before init (init names them), so they wait here until the project exists.
	const waiting = new Map<string, Map<string, Buffer>>();
	const pendingBlobs = (name: string): Map<string, Buffer> => {
		let m = waiting.get(name);
		if (!m) waiting.set(name, (m = new Map()));
		return m;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", "http://fake");
		if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "missing or wrong token" });
		const blob = /^\/p\/([^/]+)\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
		if (blob) {
			const store = projects.get(decodeURIComponent(blob[1]!))?.blobs ?? pendingBlobs(decodeURIComponent(blob[1]!));
			const sha = blob[2]!;
			if (req.method === "PUT") {
				const bytes = await readBody(req);
				if (createHash("sha256").update(bytes).digest("hex") !== sha)
					return send(res, 400, { error: "the bytes do not match the hash" });
				const stored = !store.has(sha);
				store.set(sha, bytes);
				return send(res, 200, { sha, stored });
			}
			const bytes = store.get(sha);
			if (!bytes) return send(res, 404, { error: "no such blob" });
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(bytes);
			return;
		}
		const boxFiles = /^\/p\/([^/]+)\/a\/([^/]+)\/box-files$/.exec(url.pathname);
		if (boxFiles) {
			// As the Worker answers it, from the fake box: a tar.gz of the matching files under it.
			const box = projects.get(decodeURIComponent(boxFiles[1]!))?.box;
			const glob = url.searchParams.get("glob") ?? "";
			if (glob.split("/").includes("..") || glob.startsWith("/"))
				return send(res, 400, { error: "no .. or absolute paths" });
			const pick = globTest(glob);
			const list = (dir: string, prefix: string): string[] =>
				readdirSync(join(box!, dir), { withFileTypes: true }).flatMap((e) => {
					const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
					return e.isDirectory() ? list(join(dir, e.name), rel) : [rel];
				});
			const files = box === undefined ? [] : list("", "").filter(pick);
			if (files.length === 0) return send(res, 404, { error: `nothing in the box matches ${glob}` });
			const extra = fake.boxExtra ?? [];
			const gz = tarGz([
				...files.map((rel) => ({ path: rel, data: readFileSync(join(box!, ...rel.split("/"))) })),
				...extra,
			]);
			res.writeHead(200, { "content-type": "application/gzip", "x-abso-files": String(files.length) });
			res.end(Buffer.from(gz));
			return;
		}
		const reattach = /^\/p\/([^/]+)\/a\/([^/]+)\/run\/([^/]+)$/.exec(url.pathname);
		if (reattach) {
			const run = projects.get(decodeURIComponent(reattach[1]!))?.runs.get(decodeURIComponent(reattach[3]!));
			if (!run) return send(res, 404, { error: "no such run; it ended long ago, or another run replaced it" });
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			const from = Number(url.searchParams.get("from") ?? 0);
			const errFrom = Number(url.searchParams.get("errFrom") ?? 0);
			res.write(`${JSON.stringify({ run: reattach[3], ...(run.split ? { stderr: "split" } : {}) })}\n`);
			const listen = streamRun(res, run);
			if (run.out.length > from)
				listen(`${JSON.stringify({ out: run.out.subarray(from).toString("utf8"), at: run.out.length })}\n`);
			if (run.split && run.err.length > errFrom)
				listen(`${JSON.stringify({ err: run.err.subarray(errFrom).toString("utf8"), errAt: run.err.length })}\n`);
			if (run.end !== undefined) listen(run.end);
			return;
		}
		const m =
			/^\/p\/([^/]+)\/(init|status|queue|change\/\d+|changes|notes|ci\/revoke|ci|blame|why|where|labels|files|diff|log|show|file|compare|without|a\/([^/]+)\/(edit|record|publish|sync|run|draft|land|draft-sync|diff|restore|announce|news|starting|reader|drop|pluck|amend|label|files|unqueue|note|note-close|move))$/.exec(
				url.pathname,
			);
		if (!m) return send(res, 404, { error: "no such route; see docs/v2-slice1.md" });
		const name = decodeURIComponent(m[1]!);
		const agent = m[3] === undefined ? undefined : decodeURIComponent(m[3]);
		const op = m[4] ?? m[2]!;
		const raw = await readBody(req);
		if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));

		let hosted = projects.get(name);
		if (op === "init") {
			const {
				files,
				modes,
				blobs: initBlobs,
			} = JSON.parse(raw.toString("utf8") || "{}") as {
				files?: Record<string, string>;
				modes?: Parameters<Project["init"]>[2];
				blobs?: Record<string, string>;
			};
			if (!files || typeof files !== "object") return send(res, 400, { error: "init needs {files: {path: text}}" });
			if (hosted) return send(res, 409, { error: "the project already exists" });
			const bad = Object.keys(files).find(isLocal);
			if (bad) return send(res, 400, { error: `${bad} is under .abso/, which stays in the agent's folder` });
			const store = new MemoryStore();
			const blobs = pendingBlobs(name);
			waiting.delete(name);
			// Files kept whole (#46) go to the blob store, as the Worker's do.
			const whole = {
				keep: (text: string): string => {
					const bytes = Buffer.from(text, "utf8");
					const sha = createHash("sha256").update(bytes).digest("hex");
					blobs.set(sha, bytes);
					return sha;
				},
				read: (sha: string): string | null => blobs.get(sha)?.toString("utf8") ?? null,
			};
			hosted = {
				project: new Project(store, { hasBlob: (sha) => blobs.has(sha), whole }),
				store,
				calls: new Map(),
				box: undefined,
				runs: new Map(),
				blobs,
			};
			// As the Worker with a checker: "queue": true in avcs.json turns the merge queue on (#39).
			hosted.project.checkerReady = true;
			projects.set(name, hosted);
			return send(res, 200, hosted.project.init(files, Date.now(), modes, initBlobs ?? {}));
		}
		if (!hosted) return send(res, 404, { error: "no such project; run init first" });
		// Readers (#37), with the Worker's rules; like the Worker, kept outside the log.
		const readerList = (hosted.readers ??= new Set<string>());
		const readers = {
			has: (a: string) => readerList.has(a),
			set: (a: string, on: boolean) => void (on ? readerList.add(a) : readerList.delete(a)),
			list: () => [...readerList].sort(),
		};
		if (op === "status") {
			const queue = hosted.project.queue().items.length > 0 ? { queue: queueState(hosted) } : {};
			return send(res, 200, {
				...(statusWithReaders(hosted.project.status(), readers) as object),
				...(hosted.ci ? { ci: hosted.ci.status } : {}),
				...queue,
			});
		}
		if (op === "queue") return send(res, 200, queueState(hosted));
		// Changes and notes (#44), as the Worker routes them.
		if (op === "changes" || op.startsWith("change/") || op === "notes") {
			const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
			try {
				if (op === "changes")
					return send(
						res,
						200,
						hosted.project.changes(
							q.since ? Number(q.since) : 0,
							q.limit ? Number(q.limit) : 50,
							q.before ? Number(q.before) : undefined,
						),
					);
				if (op === "notes")
					return send(
						res,
						200,
						hosted.project.notes({
							...(q.file ? { file: q.file } : {}),
							...(q.change ? { change: Number(q.change) } : {}),
							...(q.open ? { open: true } : {}),
						}),
					);
				return send(res, 200, hosted.project.change(Number(op.slice("change/".length))));
			} catch (e) {
				const code = (e as { code?: string }).code;
				return send(res, code === "not-found" ? 404 : 400, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (op === "ci" || op === "ci/revoke") {
			if (!hosted.ci) return send(res, 404, { error: "no such route; see docs/v2-slice1.md" });
			if (op === "ci/revoke") {
				const latest = hosted.ci.status.latest as { version: number; url?: string } | null;
				if (latest?.url)
					hosted.ci.status = {
						...hosted.ci.status,
						latest: { ...latest, url: `${latest.url.replace(/\/g\d+\/$/, "")}/g${Date.now()}/` },
					};
				return send(res, 200, hosted.ci.status);
			}
			const v = url.searchParams.get("version");
			if (v === null) return send(res, 200, hosted.ci.status);
			// As the Worker: a version without a job of its own is running, waiting, or not checked.
			const mark = hosted.ci.marks.get(Number(v));
			return send(
				res,
				200,
				hosted.ci.jobs.get(Number(v)) ?? {
					version: Number(v),
					result: mark === "running" || mark === "waiting" ? mark : "not checked",
				},
			);
		}
		if (agent !== undefined) {
			const gated = readerAnswer(
				hosted.project,
				op,
				agent,
				op === "reader" ? JSON.parse(raw.toString("utf8") || "{}") : undefined,
				readers,
			);
			if (gated) return send(res, gated.status, gated.body);
		}
		if (op === "where") return send(res, 200, where(hosted.project));
		if (op === "labels") return send(res, 200, hosted.project.labels());
		if (op === "diff" && agent === undefined) {
			// Another agent's draft, read only (abso diff --agent), as the Worker answers GET /p/:project/diff?agent=.
			const of = url.searchParams.get("agent");
			if (!of) return send(res, 400, { error: "diff needs ?agent=<name>" });
			try {
				return send(res, 200, hosted.project.diffOf(of));
			} catch (e) {
				const code = (e as { code?: string }).code;
				return send(res, code === "not-found" ? 404 : 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (op === "files" && agent === undefined) {
			const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
			try {
				return send(res, 200, hosted.project.pathsAt(q.version ? Number(q.version) : undefined, q.draft || null));
			} catch (e) {
				return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (op === "blame" || op === "why") {
			const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
			if (!q.file) return send(res, 400, { error: `${op} needs ?file=<path>` });
			const num = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number(s));
			try {
				const view = { draft: q.draft || undefined, agent: q.agent || undefined };
				if (op === "blame")
					return send(res, 200, blame(hosted.project, q.file, num(q.from), num(q.to), num(q.version), view));
				const line = num(q.line);
				if (!line || !Number.isInteger(line)) return send(res, 400, { error: "why needs ?line=<number>" });
				return send(res, 200, why(hosted.project, q.file, line, view));
			} catch (e) {
				const code = (e as { code?: string }).code;
				return send(res, code === "bad-request" ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (op === "without") {
			// GET ?version=<n>&versions=<n,n>, as worker/project/http.ts routes it.
			const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
			try {
				return send(
					res,
					200,
					hosted.project.without(Number(q.version), (q.versions ?? "").split(",").filter(Boolean).map(Number)),
				);
			} catch (e) {
				const code = (e as { code?: string }).code;
				return send(res, code === "bad-request" ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (op === "log" || op === "show" || op === "file" || op === "compare") {
			// As the Worker routes them: ?draft=<name>, shared when absent.
			const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
			const draft = q.draft ? q.draft : null;
			const agentSpace = q.agent ? { agent: q.agent } : {};
			const int = (s: string | undefined): number | undefined =>
				s !== undefined && s !== "" && Number.isInteger(Number(s)) ? Number(s) : undefined;
			try {
				if (op === "log") {
					const log = hosted.project.log({ draft, ...agentSpace, limit: int(q.limit), path: q.path || undefined });
					// Shared's versions only, by what the answer is (an agent may be in a named draft).
					const ci = hosted.ci;
					if (!ci || log.draft !== null) return send(res, 200, log);
					return send(res, 200, {
						...log,
						versions: log.versions.map((v) => ({ ...v, ci: ci.marks.get(v.version) ?? "not checked" })),
					});
				}
				if (op === "file") {
					const version = int(q.version);
					if (!q.path || version === undefined)
						return send(res, 400, { error: "file needs ?path=<path>&version=<number>" });
					return send(res, 200, hosted.project.fileAt(q.path, version, { draft, ...agentSpace }));
				}
				if (op === "compare") {
					const from = int(q.from);
					const to = int(q.to);
					if (from === undefined || to === undefined)
						return send(res, 400, { error: "compare needs ?from=<number>&to=<number>" });
					return send(res, 200, hosted.project.compare(from, to, { draft, ...agentSpace }));
				}
				const version = int(q.version);
				if (version === undefined) return send(res, 400, { error: "show needs ?version=<number>" });
				return send(res, 200, hosted.project.show(version, { draft, ...agentSpace }));
			} catch (e) {
				const code = (e as { code?: string }).code;
				return send(res, code === "bad-request" ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (agent === undefined || !NAME.test(agent))
			return send(res, 400, { error: "agent names use letters, digits, '.', '_' and '-'" });
		if (op === "run") {
			const key = req.headers["x-abso-run-key"];
			const dropped = fake.dropRunStarts > 0;
			fake.runStarts.push({
				key: typeof key === "string" ? key : undefined,
				started: !dropped,
				cmd: url.searchParams.get("cmd") ?? "",
				kind: String(req.headers["x-abso-kind"] ?? ""),
			});
			if (dropped) {
				fake.dropRunStarts--;
				if (fake.dropRunAs === 502) return send(res, 502, { error: "bad gateway" });
				res.socket?.destroy();
				return;
			}
			return runInBox(hosted, url.searchParams.get("cmd") ?? "", raw, res, url.searchParams.get("stderr") === "split");
		}

		const body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
		const calls = hosted.calls.get(agent) ?? [];
		hosted.calls.set(agent, calls);
		calls.push({ action: op, body });
		const project = hosted.project;
		try {
			if (op === "edit") {
				if (typeof body.file !== "string")
					return send(res, 400, { error: "edit needs {file, old, new}, {file, content} or {file, edits}" });
				if (isLocal(body.file))
					return send(res, 400, { error: `${body.file} is under .abso/, which stays in the agent's folder` });
				return send(res, 200, project.edit(agent, body as unknown as Parameters<Project["edit"]>[1], Date.now()));
			}
			if (op === "record") {
				const files = body.files as Record<string, string | null> | undefined;
				if (!files || typeof files !== "object")
					return send(res, 400, { error: "record needs {files: {path: text or null}}" });
				const bad = Object.keys(files).find(isLocal);
				if (bad) return send(res, 400, { error: `${bad} is under .abso/, which stays in the agent's folder` });
				const meta = {
					...(typeof body.session === "string" ? { session: body.session } : {}),
					...(typeof body.subagent === "string" ? { subagent: body.subagent } : {}),
				};
				return send(
					res,
					200,
					project.record(
						agent,
						files,
						Date.now(),
						body.modes as Parameters<Project["record"]>[3],
						body.blobs as Record<string, string> | undefined,
						meta,
					),
				);
			}
			if (op === "publish") {
				const message = body.message;
				if (typeof message !== "string" || !message.trim())
					return send(res, 400, { error: "push needs {message} saying why" });
				const fail = fake.failPublish;
				fake.failPublish = undefined;
				const storageReset = { error: "Internal error in Durable Object storage caused object to be reset." };
				if (fail === "before") return send(res, 500, storageReset);
				const answer = project.publish(agent, message, Date.now(), { asIs: body.asIs === true });
				if (fail === "after") return send(res, 500, storageReset);
				// A queued publish wakes the queue, as the Worker's object does.
				if ((answer as { queued?: number }).queued !== undefined) setTimeout(() => void fake.kickQueue(name), 0);
				return send(res, 200, answer);
			}
			if (op === "note") return send(res, 200, project.note(agent, body, Date.now()));
			if (op === "move") return send(res, 200, project.move(agent, body.from as string, body.to as string, Date.now()));
			if (op === "note-close") return send(res, 200, project.closeNote(agent, body.id as number, body.how, Date.now()));
			if (op === "unqueue") {
				return send(res, 200, project.unqueue(agent, Date.now()));
			}
			if (op === "draft") {
				const name = body.name;
				if (name !== null && typeof name !== "string")
					return send(res, 400, { error: "draft needs {name}, or {name: null} for shared" });
				return send(res, 200, project.switchTo(agent, name, Date.now(), { carry: body.carry === true }));
			}
			if (op === "land") {
				const message = body.message;
				if (typeof message !== "string" || !message.trim())
					return send(res, 400, { error: "land needs {message} saying why" });
				return send(res, 200, project.land(agent, message, Date.now()));
			}
			if (op === "draft-sync") return send(res, 200, project.syncDraft(agent, Date.now()));
			if (op === "files") return send(res, 200, project.agentPaths(agent));
			if (op === "diff") return send(res, 200, project.diff(agent));
			if (op === "starting")
				return send(
					res,
					200,
					project.starting(agent, body.text as string | null, body.files as string[] | undefined, Date.now()),
				);
			if (op === "announce")
				return send(
					res,
					200,
					project.announce(agent, body.text as string, body.to as string[] | undefined, Date.now()),
				);
			if (op === "news") return send(res, 200, project.news(agent));
			if (op === "restore") {
				if (body.all === true) return send(res, 200, project.restore(agent, null, Date.now()));
				if (!Array.isArray(body.files) || !body.files.every((f) => typeof f === "string"))
					return send(res, 400, { error: "restore needs {files: [path]} or {all: true}" });
				return send(res, 200, project.restore(agent, body.files as string[], Date.now()));
			}
			if (op === "drop")
				return send(
					res,
					200,
					project.drop(agent, body.versions as number[], body.message as string, Date.now(), {
						withDependents: body.withDependents === true,
					}),
				);
			if (op === "pluck")
				return send(
					res,
					200,
					project.pluck(agent, body.draft as string, body.versions as number[], body.message as string, Date.now(), {
						withDependencies: body.withDependencies === true,
					}),
				);
			if (op === "amend") return send(res, 200, project.amend(agent, body.message as string, Date.now()));
			if (op === "label")
				return send(
					res,
					200,
					project.label(agent, body.name as string, body.version as number | undefined, Date.now(), {
						remove: body.remove === true,
					}),
				);
			const synced = project.sync(agent, {
				...(typeof body.label === "string" ? { label: body.label } : {}),
				...(body.full === true ? { full: true } : {}),
			});
			const extra = fake.injectSync;
			fake.injectSync = undefined;
			if (extra === undefined) return send(res, 200, synced);
			return send(res, 200, {
				...synced,
				files: { ...synced.files, ...extra.files },
				modes: { ...synced.modes, ...extra.modes },
			});
		} catch (e) {
			const code = (e as { code?: string }).code;
			const status =
				code === "not-initialized" || code === "not-found"
					? 404
					: code === "already-initialized" || code === "conflict"
						? 409
						: code === "bad-request" || code === "bad-agent"
							? 400
							: 500;
			return send(res, status, { error: e instanceof Error ? e.message : String(e) });
		}
	};

	/** Unpack the folder into a temp box (keeping node_modules), run the command, stream ndjson. */
	const runInBox = (hosted: Hosted, cmd: string, raw: Buffer, res: ServerResponse, split: boolean): void => {
		if (hosted.box === undefined) hosted.box = mkdtempSync(join(tmpdir(), "avcs-fake-box-"));
		const box = hosted.box;
		for (const entry of readdirSync(box))
			if (entry !== "node_modules") rmSync(join(box, entry), { recursive: true, force: true });
		for (const [path, data] of untar(gunzipSync(raw))) {
			const full = join(box, ...path.split("/"));
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, data);
		}
		// The run lives on without its connection; a reattach streams from where the client got to.
		const id = `run${++runs}`;
		const run: Run = { out: Buffer.alloc(0), err: Buffer.alloc(0), split, end: undefined, listeners: new Set() };
		hosted.runs.clear();
		hosted.runs.set(id, run);
		res.writeHead(200, { "content-type": "application/x-ndjson", "x-abso-box": "warm", "x-abso-run": id });
		res.write(`${JSON.stringify({ run: id, ...(split ? { stderr: "split" } : {}) })}\n`);
		streamRun(res, run);
		const emit = (line: string): void => {
			for (const listen of [...run.listeners]) listen(line);
		};
		const out = (chunk: Buffer): void => {
			run.out = Buffer.concat([run.out, chunk]);
			emit(`${JSON.stringify({ out: chunk.toString("utf8"), at: run.out.length })}\n`);
		};
		const err = (chunk: Buffer): void => {
			if (!split) return out(chunk);
			run.err = Buffer.concat([run.err, chunk]);
			emit(`${JSON.stringify({ err: chunk.toString("utf8"), errAt: run.err.length })}\n`);
		};
		child(cmd, box, out, err, (end) => {
			run.end = end;
			emit(end);
		});
	};

	const child = (
		cmd: string,
		box: string,
		out: (chunk: Buffer) => void,
		err: (chunk: Buffer) => void,
		done: (end: string) => void,
	): void => {
		// The box's sh reads `export A='x'; command`; the shell here may be cmd.exe, so take the stamp into the environment.
		const stamped = /^export ((?:[A-Z_]+='[^']*' ?)+); ([\s\S]*)$/.exec(cmd);
		const env = { ...process.env };
		if (stamped) for (const [, k, v] of stamped[1]!.matchAll(/([A-Z_]+)='([^']*)'/g)) env[k!] = v!;
		// Node on Windows sometimes crashes as it starts (0xC0000005, about 1 start in 200 on the dev machine,
		// more when many start at once), which made the box tests flaky. The real box is Linux; a run that
		// crashed before printing anything is started once more, as a fresh box would run it.
		const start = (tries: number): void => {
			let printed = false;
			const p = spawn(stamped ? stamped[2]! : cmd, { cwd: box, shell: true, env });
			p.stdout.on("data", (chunk: Buffer) => ((printed = true), out(chunk)));
			p.stderr.on("data", (chunk: Buffer) => ((printed = true), err(chunk)));
			p.on("error", (e) => done(`${JSON.stringify({ error: e.message })}\n`));
			p.on("close", (code) => {
				if (code !== null && code >= WINDOWS_CRASH && !printed && tries < 2) return start(tries + 1);
				done(`${JSON.stringify({ exit: code ?? 1 })}\n`);
			});
		};
		start(0);
	};

	/** Send a run's lines to one connection until its end line; cut it after its first output when the test asks. */
	const streamRun = (res: ServerResponse, run: Run): ((line: string) => void) => {
		const cut = fake.cutRunStreams > 0;
		if (cut) fake.cutRunStreams--;
		const listen = (line: string): void => {
			if (res.destroyed) return;
			if (line.startsWith('{"out"') || line.startsWith('{"err"')) {
				if (cut) {
					// Drop the connection once this line has gone out, as a network that breaks mid-run.
					run.listeners.delete(listen);
					if (fake.cutRunAs === "retry")
						res.end(`${line}${JSON.stringify({ error: "the Worker is restarting (a deploy)", retry: true })}\n`);
					else res.write(line, () => res.destroy());
					return;
				}
				res.write(line);
				return;
			}
			run.listeners.delete(listen);
			res.end(line);
		};
		run.listeners.add(listen);
		res.on("close", () => run.listeners.delete(listen));
		return listen;
	};

	const server: Server = createServer((req, res) => {
		handle(req, res).catch((err: Error) => {
			if (!res.headersSent) send(res, 500, { error: err.message });
			else res.end();
		});
	});
	// Never close an idle kept-alive connection: on Windows, under load, the client could reuse one in the moment
	// the server closed it, and the next call failed with ECONNRESET. close() below drops every connection.
	server.keepAliveTimeout = 0;
	await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
	const address = server.address() as AddressInfo;
	return Object.assign(fake, {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((ok) => {
				server.closeAllConnections();
				server.close(() => ok());
				for (const p of projects.values()) if (p.box) rmSync(p.box, { recursive: true, force: true, maxRetries: 5 });
			}),
	});
}

if (import.meta.main) {
	const fake = await startFake(Number(process.argv[2] ?? 0), process.env.AVCS_TOKEN ?? "fake-token");
	console.log(`fake abso server at ${fake.url} (the real engine in memory; token from AVCS_TOKEN, else "fake-token")`);
}
