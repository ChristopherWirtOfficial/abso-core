// The Issues commands (#54) as far as the client alone decides them: which
// Issues Worker a folder talks to, whether the token may go there, the MCP
// tools, and the usage mistakes refused before any call. The Issues server
// here is a stand-in that only counts calls; the commands against the real
// store are issues/test/client-commands.test.ts, on the platform side (abso
// issue 141).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readConfig, readMachineServers } from "../src/config.ts";
import { issuesServerFor, tokenGoesTo } from "../src/core.ts";
import { searchLines } from "../src/issues.ts";
import { main } from "../src/main.ts";
import { argvFor, mcpTools } from "../src/mcp.ts";
import { type Fake, startFake } from "./fake-server.ts";

const TOKEN = "test-token-not-secret";

let fake: Fake;
let issues: Server;
let issuesUrl: string;
/** Every call the stand-in Issues server took. */
const seen: string[] = [];
/** The bodies of the copy requests it took. */
const copies: Record<string, unknown>[] = [];
const dirs: string[] = [];

before(async () => {
	fake = await startFake(0, TOKEN);
	issues = createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`);
		const send = (status: number, body: unknown) =>
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (req.method === "POST" && /\/copy$/.test(req.url ?? "")) {
			let raw = "";
			req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
			req.on("end", () => {
				const body = JSON.parse(raw) as Record<string, unknown>;
				copies.push(body);
				// Issue 403 stands for a live server refusing an agent's copy.
				if (body.issue === 403 && body.dryRun !== true)
					return send(403, { error: "copying an issue out of its project takes an owner of that project" });
				const skipped = { comments: [4], asks: [2] };
				if (body.dryRun === true)
					return send(200, {
						dryRun: true,
						plan: {
							from: { project: body.from, issue: body.issue },
							title: "Sync is slow",
							edited: ["description"],
							labels: ["client"],
							closed: { how: "done" },
							comments: [{ edited: false }, { edited: true }],
							asks: [{ edited: false }],
							skipped,
						},
					});
				send(200, { ok: true, id: 31, from: { project: body.from, issue: body.issue }, skipped });
			});
			return;
		}
		send(500, { error: "a stand-in" });
	});
	await new Promise<void>((ok) => issues.listen(0, "127.0.0.1", ok));
	issuesUrl = `http://127.0.0.1:${(issues.address() as AddressInfo).port}`;
});
after(async () => {
	await fake.close();
	await new Promise((ok) => issues.close(ok));
	for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const ENV = (): Record<string, string> => ({
	AVCS_TOKEN: TOKEN,
	AVCS_HOOK_FORCE: "1",
	AVCS_ISSUES_SERVER: issuesUrl,
	AVCS_SERVERS_FILE: "no-servers.json",
});

async function avcs(
	cwd: string,
	argv: string[],
	env: Record<string, string> = ENV(),
): Promise<{ exit: number; out: string }> {
	const r = await main([...argv, "--json"], { cwd, env, write: () => {} });
	return { exit: r.exit, out: r.stdout + r.stderr };
}

let projects = 0;
async function folder(agent: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "avcs-issues-"));
	dirs.push(dir);
	const r = await avcs(dir, ["init", "--server", fake.url, "--project", `issues${++projects}`, "--agent", agent]);
	assert.equal(r.exit, 0, r.out);
	return dir;
}

describe("issues commands, the client's part (#54)", () => {
	it("sends the token only to an Issues Worker it trusts", async () => {
		const dave = await folder("dave");
		const before = seen.length;
		const r = await avcs(dave, ["issues"], { ...ENV(), AVCS_ISSUES_SERVER: "https://issues.example.com" });
		assert.equal(r.exit, 1, r.out);
		assert.match(r.out, /sends your token only to its own servers and this machine/);
		assert.equal(seen.length, before);
		// A server with no Issues Worker beside it, and none named.
		const { AVCS_ISSUES_SERVER: _, ...without } = ENV();
		const none = await avcs(dave, ["waiting"], without);
		assert.notEqual(none.exit, 0);
		assert.match(
			none.out,
			/has no Issues Worker beside it that abso knows; ~\/\.abso\/servers\.json or ABSO_ISSUES_SERVER names one/,
		);
	});

	it("finds a server's Issues Worker in this machine's servers.json, and may send it the token", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abso-servers-"));
		dirs.push(dir);
		const file = join(dir, "servers.json");
		writeFileSync(file, JSON.stringify({ servers: { [fake.url]: { issues: issuesUrl } } }));
		const erin = await folder("erin");
		const before = seen.length;
		const { AVCS_ISSUES_SERVER: _, ...without } = ENV();
		await avcs(erin, ["waiting"], { ...without, AVCS_SERVERS_FILE: file });
		assert.ok(seen.length > before, "the call went to the Issues Worker servers.json names");
		const machine = readMachineServers({ AVCS_SERVERS_FILE: file });
		assert.equal(issuesServerFor(fake.url, machine), issuesUrl);
		assert.equal(issuesServerFor("https://abso.example", machine), undefined);
		// abso's own server and its Issues Worker are built in.
		assert.ok(tokenGoesTo("https://api.abso.dev"));
		assert.ok(tokenGoesTo("https://issues.abso.dev"));
		assert.equal(issuesServerFor("https://api.abso.dev/"), "https://issues.abso.dev");
	});

	it("are MCP tools", () => {
		const names = mcpTools().map((t) => t.name);
		for (const n of ["issues", "issue", "search", "ask", "waiting", "answer"]) assert.ok(names.includes(n), n);
		assert.deepEqual(argvFor("ask", { args: ["alice", "Which login?"], issue: "3", review: true }), [
			"ask",
			"--issue=3",
			"--review",
			"--",
			"alice",
			"Which login?",
		]);
	});

	it("refuses usage mistakes before any call", async () => {
		const erin = await folder("erin");
		const before = seen.length;
		for (const argv of [
			["issue"],
			["issue", "x"],
			["ask", "alice"],
			["ask", "a", "q", "--review", "--task"],
			["answer", "3"],
			["issue", "1", "--comment", "a", "--drop"],
			["issues", "extra"],
			["ask", "--withdraw", "x"],
			["ask", "--withdraw", "3", "alice", "q"],
			["ask", "--withdraw", "3", "--issue", "2"],
			["ask", "--withdraw", "3", "--task"],
			["ask", "alice", "q", "--note", "a note without --withdraw"],
			["search"],
			["search", "words", "--limit", "0"],
			["search", "words", "--limit", "51"],
		]) {
			const r = await avcs(erin, argv);
			assert.equal(r.exit, 1, `${argv.join(" ")}: ${r.out}`);
		}
		assert.equal(seen.length, before);
	});

	it("shows a search hit as the issue, then where it matched, without the match markers", () => {
		const issue = { id: 12, title: "Sync is slow", status: "open" as const, updated: 0, labels: [] };
		assert.deepEqual(
			searchLines({ issue, where: "comment", comment: 40, snippet: "the \u0001network\u0002 drops mid-sync" }),
			['   12  open         "Sync is slow"', '       in comment 40: "the network drops mid-sync"'],
		);
		assert.deepEqual(searchLines({ issue, where: "description", snippet: "Pages load late.", meaning: true }), [
			'   12  open         "Sync is slow"',
			'       by meaning: "Pages load late."',
		]);
		assert.deepEqual(searchLines({ issue, where: "title", snippet: "Sync is slow" })[1], "       in the title");
	});

	it("withdraw is one POST to the asker's own withdraw/<ask> route", async () => {
		const erin = await folder("erin");
		const before = seen.length;
		await avcs(erin, ["ask", "--withdraw", "#3", "--note", "overtaken by later decisions"]);
		const posts = seen.slice(before).filter((s) => s.startsWith("POST"));
		assert.equal(posts.length, 1, posts.join("\n"));
		assert.match(posts[0]!, /^POST \/p\/issues\d+\/a\/erin\/withdraw\/3$/);
	});
});

describe("abso issue <N> --copy-to <project>", () => {
	const text = async (cwd: string, argv: string[]) => {
		const r = await main(argv, { cwd, env: ENV(), write: () => {} });
		return { exit: r.exit, out: r.stdout + r.stderr };
	};

	it("a dry run asks the other project's copy route for the plan, and says nothing was written", async () => {
		const gil = await folder("gil");
		const before = seen.length;
		const r = await text(gil, ["issue", "12", "--copy-to", "core", "--dry-run"]);
		assert.equal(r.exit, 0, r.out);
		assert.deepEqual(seen.slice(before), ["POST /p/core/a/gil/copy"]);
		const from = (copies.at(-1) as { from: string }).from;
		assert.match(from, /^issues\d+$/);
		assert.deepEqual(copies.at(-1), { from, issue: 12, dryRun: true });
		assert.equal(
			r.out.trimEnd(),
			[
				`A dry run: nothing was written. Copying ${from} issue 12 into core would make:`,
				`  "Sync is slow", done (description edited when copied)`,
				"  2 comments (1 edited), 1 answered ask, labelled client",
				"  not copied: comments 4; asks 2 (open asks, and what --clean left out)",
				"Run it again without --dry-run to copy it.",
			].join("\n"),
		);
	});

	it("copies with the cleaned texts --clean gives, by source id", async () => {
		const gil = await folder("gil");
		writeFileSync(
			join(gil, "clean.json"),
			JSON.stringify({ description: "Cleaned.", comments: [{ id: 1 }, { id: 3, text: "Cleaned too." }] }),
		);
		const r = await text(gil, ["issue", "12", "--copy-to", "core", "--clean", "clean.json"]);
		assert.equal(r.exit, 0, r.out);
		const from = (copies.at(-1) as { from: string }).from;
		assert.deepEqual(copies.at(-1), {
			description: "Cleaned.",
			comments: [{ id: 1 }, { id: 3, text: "Cleaned too." }],
			from,
			issue: 12,
		});
		assert.match(
			r.out,
			new RegExp(`^Copied ${from} issue 12 to core issue 31\\. Its comments and asks keep their authors`),
		);
	});

	it("says a dry run still works when the server refuses the copy", async () => {
		const gil = await folder("gil");
		const r = await text(gil, ["issue", "403", "--copy-to", "core"]);
		assert.equal(r.exit, 1, r.out);
		assert.match(r.out, /takes an owner of that project\. --dry-run still shows what would go\./);
	});

	it("refuses mistakes before any call", async () => {
		const gil = await folder("gil");
		writeFileSync(join(gil, "bad.json"), JSON.stringify({ from: "elsewhere" }));
		const before = seen.length;
		for (const [argv, why] of [
			[["issue", "12", "--copy-to", "core", "--comment", "x"], /--copy-to goes alone .* not with --comment/],
			[["issue", "12", "--dry-run"], /--clean and --dry-run go with --copy-to <project>/],
			[["issue", "12", "--copy-to", "core", "--clean", "nope.json"], /--clean nope\.json: no such file/],
			[
				["issue", "12", "--copy-to", "core", "--clean", "bad.json"],
				/from isn't one of title, description, comments, asks/,
			],
		] as const) {
			const r = await text(gil, [...argv]);
			assert.notEqual(r.exit, 0, argv.join(" "));
			assert.match(r.out, why);
		}
		const { project } = readConfig(gil);
		assert.match(
			(await text(gil, ["issue", "12", "--copy-to", project])).out,
			/issue 12 is already in issues\d+; --copy-to names another project/,
		);
		assert.equal(seen.length, before, "nothing reached the Issues server");
	});
});
