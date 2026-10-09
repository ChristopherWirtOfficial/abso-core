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
import { readMachineServers } from "../src/config.ts";
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
const dirs: string[] = [];

before(async () => {
	fake = await startFake(0, TOKEN);
	issues = createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`);
		res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "a stand-in" }));
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
			/has no Issues Worker beside it that abso knows; ~\/\.abso\/servers\.json or AVCS_ISSUES_SERVER names one/,
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
