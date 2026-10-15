// A visitor folder: abso join <project> --reader with no sign-in, for a public project. It reads
// through the routes anyone can read and sends no credential. The rules, each a test:
// - no Authorization header and no cookie go out, with a token in the environment and a box sign-in
//   present, and no redirect is followed;
// - join answers a private project and a missing one alike, by the status answer's code alone;
// - the commands it runs are an allow-list, and a new command fails this test until it's sorted;
// - its config comes from the command line only, never from an answer;
// - what comes back goes through the terminal filter, a 429's text too;
// - show prints a file and writes nothing, even for a path outside the folder.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Api } from "../src/api.ts";
import { writeBox } from "../src/box.ts";
import { writeConfig } from "../src/config.ts";
import { isPublic } from "../src/join-commands.ts";
import { commandTable, main } from "../src/main.ts";
import { VISITOR_ELSEWHERE, VISITOR_READS } from "../src/visitor.ts";

const CLIENT = resolve(import.meta.dirname, "..", "abso.ts");
const ESC = "\x1b";
const TOKEN = "abso_test-token-never-sent";
const CREDENTIAL = "abso_bx_test-credential-never-sent";

/** Every command a visitor folder refuses. A new command fails the allow-list test until it's here or a read. */
const REFUSED = [
	"init",
	"key",
	"box",
	"whoami",
	"doctor",
	"orgs",
	"org",
	"skill",
	"join",
	"record",
	"push",
	"bisect",
	"reader",
	"settle",
	"pull",
	"run",
	"serve",
	"mv",
	"review",
	"note",
	"notes",
	"ask",
	"waiting",
	"answer",
	"ack",
	"reply",
	"unqueue",
	"visibility",
	"autosettle",
	"ci",
	"shot",
	"prep",
	"fetch",
	"pause",
	"resume",
	"logs",
	"switch",
	"land",
	"draft-pull",
	"diff",
	"restore",
	"export",
	"announce",
	"start",
	"news",
	"fix-eol",
	"who",
	"drop",
	"pluck",
	"amend",
	"label",
	"labels",
	"follow",
	"check-ignore",
	"pipeline",
];

let site: Server;
let url: string;
// Where the site's redirect points: a visitor never gets here.
let elsewhere: Server;
let elsewhereUrl: string;
const heard: { url: string; headers: IncomingHttpHeaders }[] = [];
let elsewhereHeard = 0;
const dirs: string[] = [];
const temp = (name: string) => {
	const dir = mkdtempSync(join(tmpdir(), `abso-test-visitor-${name}-`));
	dirs.push(dir);
	return dir;
};

const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers = {}) =>
	res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

before(async () => {
	elsewhere = createServer((_req, res) => {
		elsewhereHeard++;
		json(res, 200, { version: 9, agents: [] });
	});
	await new Promise<void>((done) => elsewhere.listen(0, "127.0.0.1", done));
	elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
	site = createServer((req, res) => {
		heard.push({ url: req.url ?? "", headers: req.headers });
		const path = new URL(req.url ?? "/", "http://x").pathname;
		if (path === "/p/abso-core/status")
			// An answer naming another server: the folder's config never takes it.
			return json(res, 200, { version: 3, agents: [], server: "http://answer.example" });
		if (path === "/p/abso-core/file")
			return json(res, 200, { path: "a.txt", version: 1, text: `hi ${ESC}]52;c;aGk=\x07 there\n` });
		if (path === "/p/abso-core/log")
			return json(
				res,
				429,
				{ error: `too many signed-out reads from this address: 120 a minute; sign in, or try again ${ESC}[2Jlater` },
				{ "Retry-After": "60" },
			);
		if (path === "/p/abso-core/where")
			return res.writeHead(302, { location: `${elsewhereUrl}/p/abso-core/where` }).end();
		// A private project answers 401 with a body that looks like a status: only the code counts.
		if (path === "/p/private/status") return json(res, 401, { version: 1, agents: [] });
		if (path === "/p/forbidden/status") return json(res, 403, { error: "members only" });
		if (path === "/p/missing/status") return json(res, 404, { error: "no such project" });
		json(res, 401, { error: "sign in" });
	});
	await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
	url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(() => {
	site.close();
	elsewhere.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs the client as its own process, in `cwd`, with `home` as its home and only the environment given. */
function client(
	cwd: string,
	home: string,
	args: string[],
	extra: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		AVCS_SERVERS_FILE: "no-servers.json",
		ABSO_ISSUES_SERVER: url,
		...extra,
	};
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	return new Promise((done) => {
		execFile(process.execPath, [CLIENT, ...args], { cwd, env }, (error, stdout, stderr) =>
			done({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }),
		);
	});
}

/** A visitor folder made by abso join, signed out, and the home it was made in. */
async function joined(): Promise<{ root: string; home: string; out: string }> {
	const home = temp("home");
	// In a parent of its own, so a test can tell nothing was written beside it.
	const root = join(temp("parent"), "folder");
	mkdirSync(root);
	const run = await client(root, home, ["join", "abso-core", "--reader", "--server", url]);
	assert.equal(run.code, 0, run.stderr);
	return { root, home, out: run.stdout };
}

describe("a visitor folder", () => {
	it("join --reader, signed out, to a public project writes only its config, from the command line", async () => {
		const { root, out } = await joined();
		assert.match(out, /Joined abso-core to read it signed out, at version 3/);
		assert.deepEqual(readdirSync(root), [".abso"]);
		assert.deepEqual(readdirSync(join(root, ".abso")), ["config.json"]);
		// The status answer named another server; the config keeps the one typed.
		assert.deepEqual(JSON.parse(readFileSync(join(root, ".abso", "config.json"), "utf8")), {
			server: url,
			project: "abso-core",
			visitor: true,
		});
	});

	it("sends no Authorization and no cookie, with a token set and a box sign-in present, and follows no redirect", async () => {
		const { root, home } = await joined();
		writeBox(
			{
				server: url,
				id: "b_0123abcd",
				credential: CREDENTIAL,
				grant: { projects: [{ project: "abso-core", role: "writer" }] },
				expiresAt: Date.now() + 86_400_000,
			},
			home,
		);
		const tokens = { ABSO_TOKEN: TOKEN, AVCS_TOKEN: TOKEN };
		heard.length = 0;
		elsewhereHeard = 0;
		assert.equal((await client(root, home, ["status"], tokens)).code, 0);
		assert.equal((await client(root, home, ["show", "1:a.txt"], tokens)).code, 0);
		const where = await client(root, home, ["where"], tokens);
		assert.notEqual(where.code, 0);
		assert.ok(heard.length >= 3);
		for (const { headers } of heard) {
			assert.equal(headers.authorization, undefined);
			assert.equal(headers.cookie, undefined);
			assert.doesNotMatch(JSON.stringify(headers), /never-sent/);
		}
		assert.equal(elsewhereHeard, 0);
	});

	it("asks fetch to follow no redirect and sends no credential, join's public check too (a fetch spy)", async () => {
		const root = temp("spy");
		writeConfig(root, { server: url, project: "abso-core", agent: "", visitor: true });
		const real = globalThis.fetch;
		const calls: RequestInit[] = [];
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response(JSON.stringify({ version: 3, agents: [] }), { status: 200 });
		}) as typeof fetch;
		try {
			const out = await main(["status"], { cwd: root, env: { ABSO_TOKEN: TOKEN }, write: () => {} });
			assert.equal(out.exit, 0, out.stderr);
			assert.equal(await isPublic(url, "abso-core"), true);
		} finally {
			globalThis.fetch = real;
		}
		assert.equal(calls.length, 2);
		for (const init of calls) {
			assert.equal(init.redirect, "error");
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), null);
			assert.equal(headers.get("cookie"), null);
		}
	});

	it("join answers a private project, a members-only one and a missing one alike, by the code alone", async () => {
		const runs = [];
		for (const project of ["private", "forbidden", "missing"]) {
			const root = temp("closed");
			runs.push({ root, ...(await client(root, temp("home"), ["join", project, "--reader", "--server", url])) });
		}
		for (const run of runs) {
			assert.equal(run.code, runs[0]!.code);
			assert.notEqual(run.code, 0);
			assert.equal(run.stderr, runs[0]!.stderr);
			assert.equal(existsSync(join(run.root, ".abso")), false);
		}
		assert.match(runs[0]!.stderr, /isn't signed in to .*abso login signs it in/);
	});

	it("every request its Api makes goes through one send: reads only, no redirect, no sign-in", async () => {
		const real = globalThis.fetch;
		const calls: RequestInit[] = [];
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		try {
			const visitor = new Api({ server: url, project: "abso-core", agent: "", visitor: true, token: TOKEN });
			await visitor.send(`${url}/p/abso-core/serve`, { headers: visitor.headers() });
			await assert.rejects(visitor.send(`${url}/p/abso-core/a/x/run`, { method: "POST" }), /sends only reads/);
			const member = new Api({ server: url, project: "abso-core", agent: "x", token: TOKEN });
			await member.send(`${url}/p/abso-core/serve`, { headers: member.headers() });
		} finally {
			globalThis.fetch = real;
		}
		assert.equal(calls.length, 2);
		assert.equal(calls[0]!.redirect, "error");
		assert.equal(new Headers(calls[0]!.headers).get("authorization"), null);
		assert.equal(calls[1]!.redirect, undefined);
		assert.equal(new Headers(calls[1]!.headers).get("authorization"), `Bearer ${TOKEN}`);
	});

	it("runs only its reads: every other command is refused before any call, and a new command fails here", async () => {
		const sorted = new Set([...Object.keys(VISITOR_READS), ...VISITOR_ELSEWHERE, ...REFUSED]);
		for (const name of Object.keys(commandTable()))
			assert.ok(
				sorted.has(name),
				`abso ${name} is new: add it to VISITOR_READS if it only reads, else to REFUSED here`,
			);
		const root = temp("refuse");
		writeConfig(root, { server: url, project: "abso-core", agent: "", visitor: true });
		const real = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		try {
			const tries = [
				...REFUSED.map((c) => [c]),
				["issue", "new", "a title"],
				["issue", "3", "--comment", "hi"],
				["issues", "--drafts"],
				["blame", "a.txt", "--mine"],
			];
			for (const argv of tries) {
				const out = await main(argv, { cwd: root, env: { ABSO_TOKEN: TOKEN }, write: () => {} });
				assert.notEqual(out.exit, 0, argv.join(" "));
				assert.match(out.stderr, /This folder reads abso-core signed out\. To work on it: abso login/, argv.join(" "));
			}
		} finally {
			globalThis.fetch = real;
		}
		assert.equal(calls, 0);
	});

	it("prints what comes back through the terminal filter, a 429's text too", async () => {
		const { root, home } = await joined();
		const show = await client(root, home, ["show", "1:a.txt"]);
		assert.equal(show.code, 0, show.stderr);
		assert.doesNotMatch(show.stdout, /\x1b/);
		assert.match(show.stdout, /hi \\x1b\]52;c;aGk=\\x07 there/);
		const log = await client(root, home, ["log"]);
		assert.notEqual(log.code, 0);
		assert.doesNotMatch(log.stderr + log.stdout, /\x1b/);
		assert.match(log.stderr, /too many signed-out reads from this address/);
	});

	it("show prints a file and writes nothing, even for a path outside the folder", async () => {
		const { root, home } = await joined();
		const parent = resolve(root, "..");
		const before = { here: readdirSync(root).sort(), above: readdirSync(parent).sort() };
		await client(root, home, ["show", "1:a.txt"]);
		const outside = await client(root, home, ["show", "1:../x"]);
		assert.notEqual(outside.code, 0);
		assert.deepEqual(readdirSync(root).sort(), before.here);
		assert.deepEqual(readdirSync(parent).sort(), before.above);
		assert.equal(existsSync(join(parent, "x")), false);
	});
});
