// The abso hook as a Claude Code function hook: after each Edit, MultiEdit,
// Write or NotebookEdit in an abso folder, it sends the change into the
// agent's draft, and hands any news back to the model.
//
// The agent never waits for it. The hook takes a snapshot of the file and
// returns; a queue in this module then sends the edits in the order they were
// made, each judged against its own snapshot (src/core.ts makes the same
// decisions as `abso hook`). News reaches the model as a row the engine
// appends, read at the model's next request.
//
// Outside an abso folder it costs one cached lookup. It never throws into a
// chat: on any error it logs to .avcs/hook.log and forgets the file's known
// copy, so the next `abso record` (publish and sync run one) sends it whole.

import type { Register } from "claude-code";
import {
	type EditBody,
	editBody,
	type GitIgnoreSetup,
	gitIgnoreSetup,
	ignoreFilesFor,
	LOCK_FILE,
	lockHeld,
	looksBinary,
	machineServers,
	makeIgnore,
	newsContext,
	normalize,
	readAll,
	spellingText,
	tokenGoesTo,
	trustedList,
	uncomposedText,
	type Who,
} from "../src/core.ts";
import { STAMP } from "./stamp.ts";

const TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
/** A known copy holding a NUL byte reads as no known copy (the client treats it as binary). */
const FORGOTTEN = "\u0000";
const LOG_LIMIT = 256 * 1024;
/** How long a folder's "is this in an abso folder" answer is kept. */
const ROOT_CACHE_MS = 30_000;
/** Sent with each call, so the server can tell which mod, from which commit, made it (#29). */
const CLIENT = `avcs-mod/${STAMP ?? "checkout"}`;

type Engine = Parameters<Parameters<Register>[0]>[2] extends never ? never : any;

interface Answer {
	readonly ok: boolean;
	readonly reason?: string;
	readonly news?: readonly string[];
	/** Another spelling of an existing file, recorded as it (#49). */
	readonly spelling?: readonly { path: string; existing: string }[];
	/** New names not in composed Unicode form (#49). */
	readonly uncomposed?: readonly string[];
}

/** The answer's news, with the spelling warnings (#49) the agent should hear too. */
function heardFrom(answer: Answer): readonly string[] {
	return [
		...(answer.news ?? []),
		...(answer.spelling ?? []).map(spellingText),
		...(answer.uncomposed ?? []).map(uncomposedText),
	];
}

interface Job {
	readonly root: string;
	readonly rel: string;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	/** The file right after this edit, in the server's form (undefined: missing or not text). */
	readonly snapshot: string | undefined;
	/** Where a NUL byte is, when the edit left one (the file then reads as binary). */
	readonly nul?: { readonly line: number; readonly at: number };
	readonly agentId: string | undefined;
	readonly queuedAt: number;
}

const slash = (p: string) => p.replace(/\\/g, "/");

// Module state: the jobs waiting to be sent, in order, and the folder lookup cache.
// Sending outlives the edit's own hook, so a timer started in session.start
// sends the waiting jobs; while there are none, each tick only checks a list.
const jobs: Job[] = [];
/** News that couldn't be appended, by agent ('' for the main chat), for the next edit's result. */
const pendingNews = new Map<string, string[]>();
let draining = false;
const TICK_MS = 150;
const roots = new Map<string, { root: string | undefined; at: number }>();
/** How often to ask for news without an edit (announcements reach an agent that isn't editing). */
const NEWS_POLL_MS = 30_000;
/** The abso folder this chat works in: the session's folder, or the first edited file's. */
let newsRoot: string | undefined;
let polling = false;
/** Each folder's rules from git's own files, kept as long as the folder lookup. */
const gitSetups = new Map<string, { git: GitIgnoreSetup; at: number }>();

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		$.clock.every(TICK_MS, () => {
			if (draining || jobs.length === 0) return;
			draining = true;
			void drain($).finally(() => {
				draining = false;
			});
		});
		// Outside an abso folder each tick only reads a variable.
		newsRoot = await findRoot($, `${slash(await $.session.cwd())}/.`).catch(() => undefined);
		$.clock.every(NEWS_POLL_MS, () => {
			if (polling || newsRoot === undefined) return;
			polling = true;
			void pollNews($, newsRoot).finally(() => {
				polling = false;
			});
		});
		return next(e);
	});

	on("tool.call", { tool: TOOLS }, async ($, e, next) => {
		const ran = await next(e);
		try {
			if (ran.deny !== undefined || ran.isError) return ran;
			const input = e as unknown as Record<string, unknown>;
			const raw = input.file_path ?? input.notebook_path;
			if (typeof raw !== "string" || raw === "") return ran;
			// The model may pass a path relative to the session's folder; the host resolves it.
			const path = slash(
				/^([A-Za-z]:)?[\\/]/.test(raw) ? raw : ((await $.fs.stat(raw, { resolve: true })).realPath ?? raw),
			);
			const root = await findRoot($, path);
			if (root === undefined) return ran;
			newsRoot ??= root;
			const rel = path.slice(root.length + 1);
			const text = await readOr($, path);
			const job: Job = {
				root,
				rel,
				tool: String(input.tool),
				input: Object.fromEntries(
					Object.entries(input).filter(
						([k]) => k !== "tool" && k !== "tool_use_id" && k !== "agentId" && k !== "consent",
					),
				),
				snapshot: text === undefined || looksBinary(text) ? undefined : normalize(text),
				...(text !== undefined && text.includes("\u0000")
					? { nul: { at: text.indexOf("\u0000"), line: text.slice(0, text.indexOf("\u0000")).split("\n").length } }
					: {}),
				agentId: typeof input.agentId === "string" ? input.agentId : undefined,
				queuedAt: await $.clock.now(),
			};
			jobs.push(job);
			const waitingNews = pendingNews.get(job.agentId ?? "");
			if (waitingNews !== undefined) {
				pendingNews.delete(job.agentId ?? "");
				return { ...ran, context: [...(ran.context ?? []), ...waitingNews] };
			}
		} catch {
			// Never into the chat. The next `abso record` catches up.
		}
		return ran;
	});
};

/** Send the waiting jobs one at a time, oldest first. */
async function drain($: Engine): Promise<void> {
	for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) await run($, job);
}

async function run($: Engine, job: Job): Promise<void> {
	const started = await $.clock.now().catch(() => job.queuedAt);
	let outcome: string;
	let news: readonly string[] = [];
	try {
		if ((await readOr($, `${await stateOf($, job.root)}/paused`)) !== undefined) {
			outcome = "skipped: recording is paused (abso resume)";
		} else if (/"reader"\s*:\s*true/.test((await readOr($, `${await stateOf($, job.root)}/config.json`)) ?? "")) {
			outcome = "skipped: this folder is a reader";
		} else if (await ignored($, job.root, job.rel)) {
			outcome = "skipped: ignored path";
		} else if (await isLink($, job.root, job.rel)) {
			outcome = "skipped: a link (or a file standing in for one); abso record sends links";
		} else {
			const who: Who = { session: await $.session.id(), ...(job.agentId ? { subagent: job.agentId } : {}) };
			const sent = await send($, job, who);
			outcome = sent.outcome;
			news = sent.news;
		}
	} catch (err) {
		outcome = `error: ${(err as Error).message}`;
		await $.fs.write(`${await stateOf($, job.root)}/known/${job.rel}`, FORGOTTEN).catch(() => {});
	}
	const done = await $.clock.now().catch(() => started);
	await log(
		$,
		job.root,
		`${new Date(job.queuedAt).toISOString()}\t${job.tool}\t${job.rel}\t${outcome}\t${done - started}ms sending, ${started - job.queuedAt}ms queued (in process, async)\t${CLIENT}`,
	);
	const context = newsContext(news);
	if (context === undefined) return;
	// For anything that shows news later (the avcs-view mod reads it).
	const at = new Date(done).toISOString();
	await log($, job.root, news.map((n) => `${at}\t${n}`).join("\n"), "news.log");
	try {
		await $.session.append({
			message: { type: "user", content: [{ type: "text", text: context }] },
			...(job.agentId ? { agentId: job.agentId } : {}),
		});
	} catch {
		// Older Claude Code has no append; the agent's next edit carries it instead.
		const key = job.agentId ?? "";
		pendingNews.set(key, [...(pendingNews.get(key) ?? []), context]);
	}
}

/** Ask for the news waiting for this agent (announcements, collisions) and hand it to the model. */
async function pollNews($: Engine, root: string): Promise<void> {
	try {
		const config = JSON.parse(await $.fs.read(`${await stateOf($, root)}/config.json`)) as {
			server: string;
			project: string;
			agent: string;
		};
		const bearer = await token($, config.server);
		const r = await $.http.fetch(
			`${config.server.replace(/\/+$/, "")}/p/${encodeURIComponent(config.project)}/a/${encodeURIComponent(config.agent)}/news`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-abso-client": CLIENT,
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
				},
				body: "{}",
			},
		);
		if (!r.ok) return;
		const news = ((JSON.parse(r.text) as { news?: readonly string[] }).news ?? []).filter(
			(n) => typeof n === "string" && n.trim() !== "",
		);
		const context = newsContext(news);
		if (context === undefined) return;
		const at = new Date(await $.clock.now()).toISOString();
		await log($, root, news.map((n) => `${at}\t${n}`).join("\n"), "news.log");
		try {
			await $.session.append({ message: { type: "user", content: [{ type: "text", text: context }] } });
		} catch (err) {
			// It rides on the next edit's result instead; say why in the log.
			await log($, root, `${at}\tnews\t-\tcould not append (${(err as Error).message}); the next edit carries it`);
			pendingNews.set("", [...(pendingNews.get("") ?? []), context]);
		}
	} catch {
		// The next poll, edit or abso command picks it up; nothing is lost on the server.
	}
}

async function readOr($: Engine, path: string): Promise<string | undefined> {
	try {
		return await $.fs.read(path);
	} catch {
		return undefined;
	}
}

/** A folder's state folder: .abso, or .avcs in a folder from before the rename. (A mod can't import the client's state-dir.ts.) */
async function stateOf($: Engine, root: string): Promise<string> {
	return (await $.fs.exists(`${root}/.abso/config.json`)) ? `${root}/.abso` : `${root}/.avcs`;
}

/** A file under the user's home: ~/.abso/<name>, else the older ~/.avcs/<name>. */
async function readHome($: Engine, home: string, name: string): Promise<string | undefined> {
	return (await readOr($, `${slash(home)}/.abso/${name}`)) ?? (await readOr($, `${slash(home)}/.avcs/${name}`));
}

/** Whether the server has this path as a symbolic link (.avcs/modes.json, written by the client). */
async function isLink($: Engine, root: string, rel: string): Promise<boolean> {
	const raw = await readOr($, `${await stateOf($, root)}/modes.json`);
	if (raw === undefined) return false;
	try {
		const modes = JSON.parse(raw) as Record<string, { link?: unknown }>;
		return typeof modes[rel]?.link === "string";
	} catch {
		return false;
	}
}

/** The client's ignore rules (src/core.ts), reading only the ignore files above the path. */
async function ignored($: Engine, root: string, rel: string): Promise<boolean> {
	const now = await $.clock.now();
	let setup = gitSetups.get(root);
	if (!setup || now - setup.at >= ROOT_CACHE_MS) {
		const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE"));
		const xdgConfigHome = await $.env.get("XDG_CONFIG_HOME");
		const git = await readAll(gitIgnoreSetup(root, { home, ...(xdgConfigHome ? { xdgConfigHome } : {}) }), (p) =>
			readOr($, p),
		);
		setup = { git, at: now };
		gitSetups.set(root, setup);
	}
	const files = new Map<string, string | undefined>();
	for (const f of ignoreFilesFor(rel)) files.set(f, await readOr($, `${root}/${f}`));
	return makeIgnore((f) => files.get(f), setup.git)(rel, false);
}

/** The nearest folder above the file that has .abso/config.json (or .avcs/config.json from before the rename), cached per folder. */
async function findRoot($: Engine, path: string): Promise<string | undefined> {
	const start = path.slice(0, path.lastIndexOf("/"));
	const now = await $.clock.now();
	const hit = roots.get(start);
	if (hit && now - hit.at < ROOT_CACHE_MS) return hit.root;
	let found: string | undefined;
	let dir = start;
	while (dir.includes("/")) {
		if ((await $.fs.exists(`${dir}/.abso/config.json`)) || (await $.fs.exists(`${dir}/.avcs/config.json`))) {
			found = dir;
			break;
		}
		const up = dir.slice(0, dir.lastIndexOf("/"));
		if (up === dir || up === "" || /^[A-Za-z]:$/.test(up)) break;
		dir = up;
	}
	roots.set(start, { root: found, at: now });
	return found;
}

/** AVCS_TOKEN if set, else ~/.abso/token, else ~/.avcs/token; none for a server the token may not go to (core.ts tokenGoesTo, with this machine's servers.json). */
async function token($: Engine, server: string): Promise<string | undefined> {
	const home = (await $.env.get("USERPROFILE")) ?? (await $.env.get("HOME"));
	const machine = machineServers(home ? await readHome($, home, "servers.json") : undefined);
	if (!tokenGoesTo(server, trustedList(await $.env.get("AVCS_TRUSTED_SERVERS"), machine))) return undefined;
	const env = await $.env.get("AVCS_TOKEN");
	if (env) return env.trim();
	return home ? (await readHome($, home, "token"))?.trim() || undefined : undefined;
}

async function send($: Engine, job: Job, who: Who): Promise<{ outcome: string; news: readonly string[] }> {
	const { root, rel } = job;
	// While an abso command changes the folder's records, leave the known copy alone: the next record sends the file (#51).
	if (lockHeld(await readOr($, `${await stateOf($, root)}/${LOCK_FILE}`), Date.now()))
		return { outcome: "skipped: another abso command is changing this folder; abso record sends it", news: [] };
	const disk = job.snapshot;
	const knownPath = `${await stateOf($, root)}/known/${rel}`;
	const knownRaw = await readOr($, knownPath);
	if (disk === undefined) {
		if (job.nul !== undefined && knownRaw !== undefined && !looksBinary(knownRaw)) {
			// A text file an edit left with a NUL byte: tell the agent now, not forty minutes later (#25).
			const warning = `${rel} now has a NUL byte at line ${job.nul.line} (character ${job.nul.at}), so it reads as binary. abso will not send or publish it, and the other agents keep its last text, until the NUL is gone.`;
			return { outcome: `not sent: a NUL byte at line ${job.nul.line}`, news: [warning] };
		}
		return { outcome: "skipped: file is missing or not text; abso record catches up", news: [] };
	}
	const known = knownRaw === undefined || looksBinary(knownRaw) ? undefined : knownRaw;

	const config = JSON.parse(await $.fs.read(`${await stateOf($, root)}/config.json`)) as {
		server: string;
		project: string;
		agent: string;
	};
	const bearer = await token($, config.server);
	const post = async (action: string, payload: unknown): Promise<Answer> => {
		const url = `${config.server.replace(/\/+$/, "")}/p/${encodeURIComponent(config.project)}/a/${encodeURIComponent(config.agent)}/${action}`;
		const r = await $.http.fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-abso-client": CLIENT,
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			},
			body: JSON.stringify(payload),
		});
		if (!r.ok) throw new Error(`${action} answered ${r.status}: ${r.text.slice(0, 300)}`);
		return JSON.parse(r.text) as Answer;
	};

	const body: EditBody | undefined = editBody(job.tool, job.input, rel, known, disk, who);
	if (body !== undefined) {
		const answer = await post("edit", body);
		if (answer.ok) {
			await remember($, knownPath, disk);
			return { outcome: body.content !== undefined ? "sent write" : "sent edit", news: heardFrom(answer) };
		}
		if (answer.reason !== "out of step") throw new Error(`edit refused: ${answer.reason}`);
	}
	const answer = await post("record", { files: { [rel]: disk }, ...who });
	if (!answer.ok) throw new Error(`record refused: ${answer.reason ?? "no reason given"}`);
	await remember($, knownPath, disk);
	return { outcome: body === undefined ? "sent whole file" : "out of step; sent whole file", news: heardFrom(answer) };
}

/** Keep the known copy in step. */
async function remember($: Engine, knownPath: string, text: string): Promise<void> {
	await $.fs.write(knownPath, text);
}

/** One line per edit in .avcs/hook.log (or another log there), as the command hook writes, kept under LOG_LIMIT. */
async function log($: Engine, root: string, line: string, file = "hook.log"): Promise<void> {
	try {
		const path = `${await stateOf($, root)}/${file}`;
		let text = `${(await readOr($, path)) ?? ""}${line}\n`;
		if (text.length > LOG_LIMIT) text = text.slice(text.indexOf("\n", text.length - LOG_LIMIT / 2) + 1);
		await $.fs.write(path, text);
	} catch {
		// Logging is best effort.
	}
}
