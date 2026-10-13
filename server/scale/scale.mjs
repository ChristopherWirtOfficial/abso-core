#!/usr/bin/env node
// A scale harness for abso's open server (server/). It talks HTTP directly, as the client does, so one machine can
// play thousands of agents across many projects. Each project is its own Durable Object and Artifacts repo, so total
// pushes a second should grow with the number of projects while each project's own latency stays flat.
//
//   node server/scale/scale.mjs --server <url> [--projects 10] [--agents 5] [--rounds 3] [--overlap 0.2]
//   node server/scale/scale.mjs --server <url> --ramp
//
// The token comes from ABSO_TOKEN, or from the file --token-file names. It is never printed. README.md says more.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOT_LINES = 40;
/** The ramp's stages: projects × agents per project. */
export const RAMP = [
	[1, 1],
	[10, 5],
	[50, 10],
	[100, 10],
	[200, 20],
];

function parseArgs(argv) {
	const o = {
		server: "",
		projects: 10,
		agents: 5,
		rounds: 3,
		overlap: 0.2,
		prefix: "",
		concurrency: 256,
		maxSeconds: 240,
		artifactsSample: 5,
		artifactsWait: 180,
		tokenFile: "",
		ramp: false,
		stopErrorRate: 0.02,
		out: join(HERE, "results"),
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "--server") o.server = next().replace(/\/+$/, "");
		else if (a === "--projects") o.projects = Number(next());
		else if (a === "--agents") o.agents = Number(next());
		else if (a === "--rounds") o.rounds = Number(next());
		else if (a === "--overlap") o.overlap = Number(next());
		else if (a === "--prefix") o.prefix = next();
		else if (a === "--concurrency") o.concurrency = Number(next());
		else if (a === "--max-seconds") o.maxSeconds = Number(next());
		else if (a === "--artifacts-sample") o.artifactsSample = Number(next());
		else if (a === "--artifacts-wait") o.artifactsWait = Number(next());
		else if (a === "--token-file") o.tokenFile = next();
		else if (a === "--out") o.out = next();
		else if (a === "--ramp") o.ramp = true;
		else if (a === "--help" || a === "-h") o.help = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return o;
}

/** The value at fraction q of sorted numbers (nearest rank), or null when there are none. */
export function percentile(sorted, q) {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const round = (n, places = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** places) / 10 ** places);

/** At most `limit` calls in flight at once. */
function limiter(limit) {
	let active = 0;
	const queue = [];
	const release = () => {
		active--;
		const next = queue.shift();
		if (next) next();
	};
	return async (work) => {
		if (active >= limit) await new Promise((ok) => queue.push(ok));
		active++;
		try {
			return await work();
		} finally {
			release();
		}
	};
}

/** Latencies by operation, statuses, and the counts the summary reports. */
class Stats {
	ops = new Map();
	statuses = new Map();
	errors = new Map();
	requests = 0;
	pushes = 0;
	held = 0;
	settled = 0;
	heldAfterRetry = 0;
	perProject = new Map();
	time(op, ms, status) {
		if (!this.ops.has(op)) this.ops.set(op, []);
		this.ops.get(op).push(ms);
		this.requests++;
		this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
		if (status === "network" || Number(status) >= 400) {
			const key = `${op} ${status}`;
			this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
		}
	}
	pushed(project) {
		this.pushes++;
		this.perProject.set(project, (this.perProject.get(project) ?? 0) + 1);
	}
	errorCount() {
		let n = 0;
		for (const v of this.errors.values()) n += v;
		return n;
	}
	latency() {
		const out = {};
		for (const [op, list] of [...this.ops].sort()) {
			const s = [...list].sort((a, b) => a - b);
			out[op] = {
				count: s.length,
				p50: round(percentile(s, 0.5)),
				p95: round(percentile(s, 0.95)),
				p99: round(percentile(s, 0.99)),
				max: round(s.at(-1)),
			};
		}
		return out;
	}
}

class Client {
	constructor(server, token, stats, limit) {
		this.server = server;
		this.token = token;
		this.stats = stats;
		this.limit = limit;
	}
	/** One request, timed. Answers {status, body}; a network failure is status "network". */
	async call(method, path, body, op, raw) {
		return this.limit(async () => {
			const t0 = performance.now();
			let status = "network";
			try {
				const res = await fetch(`${this.server}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${this.token}`,
						"x-abso-client": "abso-scale/1",
						...(raw
							? { "content-type": "application/octet-stream" }
							: body !== undefined
								? { "content-type": "application/json" }
								: {}),
					},
					...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
					signal: AbortSignal.timeout(120_000),
				});
				status = String(res.status);
				const text = await res.text();
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = text;
				}
				return { status: res.status, body: parsed };
			} catch (e) {
				return { status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
			} finally {
				this.stats.time(op, performance.now() - t0, status);
			}
		});
	}
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hotText = () => Array.from({ length: HOT_LINES }, (_, i) => `hot line ${i + 1}`).join("\n") + "\n";

/** Makes a project: one starting file per agent is left to the agents; init holds the hot file, a readme and a blob. */
async function initProject(client, project) {
	const bytes = randomBytes(256);
	const sha = createHash("sha256").update(bytes).digest("hex");
	const put = await client.call("PUT", `/p/${project}/blobs/${sha}`, undefined, "blob", bytes);
	if (put.status !== 200) return { ok: false, why: `blob ${put.status}` };
	const init = await client.call(
		"POST",
		`/p/${project}/init`,
		{ files: { "README.md": `# ${project}\n\nA scale run.\n`, "hot.txt": hotText() }, blobs: { "logo.bin": sha } },
		"init",
	);
	return init.status === 200 ? { ok: true } : { ok: false, why: `init ${init.status}` };
}

/** One agent: join, say what it starts on, then rounds of edit, record and publish. A held push pulls and retries once. */
async function runAgent(client, stats, project, agent, o, deadline) {
	const base = `/p/${project}/a/${agent}`;
	const view = new Map();
	const take = (files) => {
		for (const [path, text] of Object.entries(files ?? {})) {
			if (text === null) view.delete(path);
			else view.set(path, text);
		}
	};
	const join = await client.call("POST", `${base}/sync`, {}, "sync");
	if (join.status !== 200) return;
	take(join.body.files);
	await client.call("POST", `${base}/starting`, { text: `Scale run: ${agent} edits its own file` }, "starting");
	const own = `agents/${agent}.txt`;
	let mine = "";
	for (let r = 1; r <= o.rounds && Date.now() < deadline; r++) {
		const hot = Math.random() < o.overlap;
		let files;
		if (hot) {
			// Pull first, as an agent does before it touches a file others work on.
			const pulled = await client.call("POST", `${base}/sync`, {}, "sync");
			if (pulled.status !== 200) continue;
			take(pulled.body.files);
			const lines = (view.get("hot.txt") ?? hotText()).split("\n");
			const at = Math.floor(Math.random() * Math.min(3, lines.length - 1));
			lines[at] = `hot line ${at + 1}, as ${agent} wants it in round ${r}`;
			files = { "hot.txt": lines.join("\n") };
		} else {
			mine += `${agent} round ${r}\n`;
			files = { [own]: mine };
		}
		const rec = await client.call("POST", `${base}/record`, { files }, "record");
		if (rec.status !== 200) continue;
		for (const [p, t] of Object.entries(files)) view.set(p, t);
		let pub = await client.call("POST", `${base}/publish`, { message: `${agent} round ${r}` }, "publish");
		if (pub.status === 200 && pub.body.ok === false) {
			stats.held++;
			// Settle: pull (both sides' lines come back), then push with both sides kept, as abso push --as-is does.
			const pulled = await client.call("POST", `${base}/sync`, {}, "sync");
			if (pulled.status === 200) take(pulled.body.files);
			pub = await client.call(
				"POST",
				`${base}/publish`,
				{ message: `${agent} round ${r}, settled`, asIs: true },
				"publish",
			);
			if (pub.status === 200 && pub.body.ok === true) stats.settled++;
			else if (pub.status === 200) stats.heldAfterRetry++;
		}
		if (pub.status === 200 && pub.body.ok === true) {
			stats.pushed(project);
			stats.lastPush.set(project, Date.now());
		}
		await client.call("POST", `${base}/news`, {}, "news");
	}
}

/** For a sample of projects: how long after its last push until /out says Artifacts holds shared's newest version. */
async function artifactsLag(client, projects, stats, o) {
	const sample = projects.slice(0, o.artifactsSample);
	const until = Date.now() + o.artifactsWait * 1000;
	const results = await Promise.all(
		sample.map(async (project) => {
			for (;;) {
				const out = await client.call("GET", `/p/${project}/out`, undefined, "out");
				const b = out.body ?? {};
				if (out.status === 200 && b.version !== null && b.pushed && b.pushed.version >= b.version) {
					const last = stats.lastPush.get(project) ?? stats.started;
					return { project, version: b.version, seconds: round((Date.now() - last) / 1000), error: null };
				}
				if (out.status === 200 && b.artifacts === "unbound")
					return { project, version: b.version, seconds: null, error: "artifacts unbound" };
				if (Date.now() > until)
					return {
						project,
						version: b.version ?? null,
						seconds: null,
						error: b.error ? `not pushed: ${JSON.stringify(b.error).slice(0, 160)}` : "not pushed in time",
					};
				await sleep(3000);
			}
		}),
	);
	const done = results
		.map((r) => r.seconds)
		.filter((s) => s !== null)
		.sort((a, b) => a - b);
	return {
		sampled: sample.length,
		pushedOut: done.length,
		p50Seconds: percentile(done, 0.5),
		maxSeconds: done.at(-1) ?? null,
		projects: results,
	};
}

/** One stage: P projects × A agents × R rounds. */
export async function runStage(o, token, name) {
	const stats = new Stats();
	stats.lastPush = new Map();
	const client = new Client(o.server, token, stats, limiter(o.concurrency));
	const projects = Array.from({ length: o.projects }, (_, i) => `${o.prefix}-${name}-p${i + 1}`.toLowerCase());
	stats.started = Date.now();
	const made = await Promise.all(projects.map((p) => initProject(client, p)));
	const live = projects.filter((_, i) => made[i].ok);
	const initSeconds = (Date.now() - stats.started) / 1000;
	const t0 = Date.now();
	const deadline = t0 + o.maxSeconds * 1000;
	await Promise.all(
		live.flatMap((p) =>
			Array.from({ length: o.agents }, (_, a) => runAgent(client, stats, p, `agent-${a + 1}`, o, deadline)),
		),
	);
	const seconds = (Date.now() - t0) / 1000;
	const lag = await artifactsLag(client, live, stats, o);
	const perProject = [...stats.perProject.values()].map((n) => n / seconds).sort((a, b) => a - b);
	return {
		stage: name,
		server: o.server,
		at: new Date(t0).toISOString(),
		projects: o.projects,
		projectsMade: live.length,
		agentsPerProject: o.agents,
		agents: live.length * o.agents,
		rounds: o.rounds,
		overlap: o.overlap,
		initSeconds: round(initSeconds),
		seconds: round(seconds),
		cutShort: Date.now() > deadline,
		pushes: stats.pushes,
		pushesPerSecond: round(stats.pushes / seconds, 2),
		pushesPerSecondPerProject: {
			p50: round(percentile(perProject, 0.5), 3),
			min: round(perProject[0] ?? null, 3),
			max: round(perProject.at(-1) ?? null, 3),
		},
		held: stats.held,
		settledOnRetry: stats.settled,
		heldAfterRetry: stats.heldAfterRetry,
		requests: stats.requests,
		requestsPerSecond: round(stats.requests / seconds, 1),
		errors: stats.errorCount(),
		errorRate: round(stats.errorCount() / Math.max(1, stats.requests), 4),
		errorsByStatus: Object.fromEntries(stats.errors),
		statuses: Object.fromEntries(stats.statuses),
		latencyMs: stats.latency(),
		artifacts: lag,
		failedProjects: projects.filter((_, i) => !made[i].ok).map((p, i) => ({ project: p, why: made[i]?.why })),
	};
}

export function summaryRow(r) {
	const pub = r.latencyMs.publish ?? {};
	const lag = r.artifacts.p50Seconds === null ? "n/a" : `${r.artifacts.p50Seconds} s (max ${r.artifacts.maxSeconds} s)`;
	return `| ${r.projectsMade}×${r.agentsPerProject} | ${r.agents} | ${r.pushes} | ${r.pushesPerSecond} | ${pub.p50 ?? "n/a"} | ${pub.p95 ?? "n/a"} | ${r.held} (${r.heldAfterRetry} still held) | ${r.errors} (${(r.errorRate * 100).toFixed(2)}%) | ${lag} (${r.artifacts.pushedOut}/${r.artifacts.sampled}) |`;
}

export const SUMMARY_HEAD = [
	"| Stage (projects×agents) | Agents | Pushes | Pushes/s | Push p50 ms | Push p95 ms | Held | Errors | Artifacts lag p50 (pushed/sampled) |",
	"|---|---|---|---|---|---|---|---|---|",
];

function latencyTable(r) {
	const lines = ["| Operation | Count | p50 ms | p95 ms | p99 ms | max ms |", "|---|---|---|---|---|---|"];
	for (const [op, l] of Object.entries(r.latencyMs))
		lines.push(`| ${op} | ${l.count} | ${l.p50} | ${l.p95} | ${l.p99} | ${l.max} |`);
	return lines.join("\n");
}

function readToken(o) {
	if (o.tokenFile)
		return readFileSync(
			o.tokenFile.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? "~"),
			"utf8",
		).trim();
	return (process.env.ABSO_TOKEN ?? "").trim();
}

async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help || !o.server) {
		console.log(readFileSync(join(HERE, "README.md"), "utf8"));
		return;
	}
	const token = readToken(o);
	if (!token) throw new Error("no token: set ABSO_TOKEN or pass --token-file <file>");
	const runId = Date.now().toString(36);
	o.prefix ||= `scale-${runId}`;
	mkdirSync(o.out, { recursive: true });
	const stages = o.ramp ? RAMP : [[o.projects, o.agents]];
	const rows = [];
	const files = [];
	for (const [projects, agents] of stages) {
		const name = `${projects}x${agents}`;
		console.error(`stage ${name}: ${projects} projects × ${agents} agents × ${o.rounds} rounds on ${o.server}`);
		const r = await runStage({ ...o, projects, agents }, token, name);
		const file = join(o.out, `${o.prefix}-${name}.json`);
		writeFileSync(file, `${JSON.stringify(r, null, "\t")}\n`);
		files.push(file);
		rows.push(r);
		console.log(`\n### Stage ${name}\n\n${SUMMARY_HEAD.join("\n")}\n${summaryRow(r)}\n\n${latencyTable(r)}\n`);
		if (r.errorRate > o.stopErrorRate || r.projectsMade < r.projects) {
			console.log(
				`Stopped after stage ${name}: errors ${(r.errorRate * 100).toFixed(2)}%, projects made ${r.projectsMade} of ${r.projects}.`,
			);
			break;
		}
	}
	if (rows.length > 1) {
		const summary = {
			prefix: o.prefix,
			server: o.server,
			rounds: o.rounds,
			overlap: o.overlap,
			stages: rows
				.map((r) => ({
					...r,
					latencyMs: { publish: r.latencyMs.publish, record: r.latencyMs.record, sync: r.latencyMs.sync },
				}))
				.map(({ artifacts, statuses, ...r }) => ({
					...r,
					artifacts: {
						sampled: artifacts.sampled,
						pushedOut: artifacts.pushedOut,
						p50Seconds: artifacts.p50Seconds,
						maxSeconds: artifacts.maxSeconds,
					},
				})),
		};
		writeFileSync(join(o.out, `${o.prefix}-ramp.json`), `${JSON.stringify(summary, null, "\t")}\n`);
		console.log(`\n## Ramp ${o.prefix}\n\n${SUMMARY_HEAD.join("\n")}\n${rows.map(summaryRow).join("\n")}\n`);
	}
	console.error(`results: ${files.join(", ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	});
}
