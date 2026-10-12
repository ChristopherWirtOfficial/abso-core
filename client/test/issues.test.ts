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
import { issuePage, searchLines } from "../src/issues.ts";
import type { IssuePage } from "../src/issues-wire.ts";
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
/** The bodies of the replies it took. */
const replies: { text: string; question?: boolean }[] = [];
/** An open ask of fay's from desk with a thread: fay's ack, then a question back, so it waits on desk. */
const threaded = {
	id: 7,
	issue: 3,
	title: "Pull is slow",
	by: "desk",
	of: "fay",
	kind: "question",
	question: "Which way?",
	review: false,
	due: null,
	recommendation: null,
	options: [],
	blocks: [],
	at: 0,
	answer: null,
	seen: 0,
	ack: { at: 0, note: "ok, let me check" },
	replies: [
		{ id: 1, by: "fay", text: "ok, let me check", at: 0 },
		{ id: 2, by: "fay", text: "staging or live?\nlive is 906", at: 0, question: true },
	],
	waitingOn: "desk",
};
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
							title: "Pull is slow",
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
		// An ack answers with the ask, acknowledged and still open.
		const ack = /\/a\/([^/]+)\/ack\/(\d+)$/.exec(req.url ?? "");
		if (req.method === "POST" && ack)
			return send(200, {
				ask: { id: Number(ack[2]), by: "desk", of: ack[1], answer: null, ack: { at: Date.now(), note: "" } },
			});
		// Ask 404 stands for a server from before ask threads: neither route is there.
		if (/\/(ask|reply)\/404$/.test(req.url ?? "")) return send(404, { error: "no such issues route" });
		// A reply answers with the ask; from the one asked, a question makes it wait on the asker.
		const reply = /\/a\/([^/]+)\/reply\/(\d+)$/.exec(req.url ?? "");
		if (req.method === "POST" && reply) {
			let raw = "";
			req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
			req.on("end", () => {
				const body = JSON.parse(raw) as { text: string; question?: boolean };
				replies.push(body);
				send(200, {
					ask: {
						id: Number(reply[2]),
						by: "desk",
						of: reply[1],
						answer: null,
						waitingOn: body.question ? "desk" : reply[1],
					},
				});
			});
			return;
		}
		// One ask with its thread, and the asks an agent sent.
		const one = /\/ask\/(\d+)$/.exec(req.url ?? "");
		if (req.method === "GET" && one) return send(200, { ask: { ...threaded, id: Number(one[1]) } });
		if (req.method === "GET" && /\/a\/[^/]+\/asked$/.test(req.url ?? ""))
			return send(200, {
				asks: [
					threaded,
					{ ...threaded, id: 8, replies: [], answer: { by: "fay", words: "yes", at: 0 }, waitingOn: null },
				],
			});
		send(500, { error: "a stand-in" });
	});
	// As fake-server.ts: never close an idle kept-alive connection, or under load the client can reuse one as it closes
	// and fail with ECONNRESET (abso 410).
	issues.keepAliveTimeout = 0;
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
		for (const n of ["issues", "issue", "search", "ask", "waiting", "answer", "ack", "reply"])
			assert.ok(names.includes(n), n);
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
		const unknownAuthorship = {
			kind: "unknown" as const,
			actor: null,
			provenance: "unknown" as const,
			authorField: null,
		};
		const issue = {
			id: 12,
			title: "Pull is slow",
			status: "open" as const,
			updated: 0,
			labels: [],
			authorship: { title: unknownAuthorship },
		};
		assert.deepEqual(
			searchLines({
				issue,
				where: "comment",
				comment: 40,
				snippet: "the \u0001network\u0002 drops mid-sync",
				matchedAuthorship: unknownAuthorship,
			}),
			['   12  open         "Pull is slow"', '       in comment 40: "the network drops mid-sync"'],
		);
		assert.deepEqual(
			searchLines({
				issue,
				where: "description",
				snippet: "Pages load late.",
				meaning: true,
				matchedAuthorship: unknownAuthorship,
			}),
			['   12  open         "Pull is slow"', '       by meaning: "Pages load late."'],
		);
		assert.deepEqual(
			searchLines({ issue, where: "title", snippet: "Pull is slow", matchedAuthorship: unknownAuthorship })[1],
			"       in the title",
		);
	});

	it("withdraw is one POST to the asker's own withdraw/<ask> route", async () => {
		const erin = await folder("erin");
		const before = seen.length;
		await avcs(erin, ["ask", "--withdraw", "#3", "--note", "overtaken by later decisions"]);
		const posts = seen.slice(before).filter((s) => s.startsWith("POST"));
		assert.equal(posts.length, 1, posts.join("\n"));
		assert.match(posts[0]!, /^POST \/p\/issues\d+\/a\/erin\/withdraw\/3$/);
	});

	it("ack is one POST to the one asked's ack/<ask> route, and says the ask stays open", async () => {
		const fay = await folder("fay");
		const before = seen.length;
		const r = await main(["ack", "7", "on it after the deploy"], { cwd: fay, env: ENV(), write: () => {} });
		assert.equal(r.exit, 0, r.stdout + r.stderr);
		assert.equal(
			r.stdout,
			'Acknowledged ask 7. desk hears it; abso reply 7 "..." adds more as you go, and the ask stays open until abso answer 7 "...".\n',
		);
		const posts = seen.slice(before).filter((s) => s.startsWith("POST"));
		assert.deepEqual(posts.length, 1, posts.join("\n"));
		assert.match(posts[0]!, /^POST \/p\/issues\d+\/a\/fay\/ack\/7$/);
		assert.equal((await main(["ack"], { cwd: fay, env: ENV(), write: () => {} })).exit, 1);
	});

	it("reply is one POST to reply/<ask> with the words, and says whose turn it is", async () => {
		const fay = await folder("fay");
		const before = seen.length;
		const r = await main(["reply", "7", "staging or live?", "--question"], { cwd: fay, env: ENV(), write: () => {} });
		assert.equal(r.exit, 0, r.stdout + r.stderr);
		const posts = seen.slice(before).filter((s) => s.startsWith("POST"));
		assert.equal(posts.length, 1, posts.join("\n"));
		assert.match(posts[0]!, /^POST \/p\/issues\d+\/a\/fay\/reply\/7$/);
		assert.deepEqual(replies.at(-1), { text: "staging or live?", question: true });
		assert.equal(r.stdout, "Replied on ask 7. desk hears it. It waits on desk.\n");
		assert.equal((await main(["reply", "7"], { cwd: fay, env: ENV(), write: () => {} })).exit, 1);
	});

	it("names a server from before ask threads instead of a bare 404", async () => {
		const fay = await folder("fay");
		for (const argv of [
			["reply", "404", "still there?"],
			["ask", "404"],
		]) {
			const r = await main(argv, { cwd: fay, env: ENV(), write: () => {} });
			assert.equal(r.exit, 1, argv.join(" "));
			assert.match(r.stderr, /doesn't have ask threads yet/, argv.join(" "));
			assert.doesNotMatch(r.stderr, /no such issues route/, argv.join(" "));
		}
	});

	it("ask <N> reads one ask with its whole thread, oldest first, and whose turn it is", async () => {
		const fay = await folder("fay");
		const before = seen.length;
		const r = await main(["ask", "7"], { cwd: fay, env: ENV(), write: () => {} });
		assert.equal(r.exit, 0, r.stdout + r.stderr);
		assert.match(seen.slice(before).join("\n"), /^GET \/p\/issues\d+\/ask\/7$/m);
		assert.match(
			r.stdout,
			/^ {2}ask 7: desk, .* asks fay a question on issue 3 \("Pull is slow"\) \(2 replies; waiting on desk\): "Which way\?"$/m,
		);
		const ack = r.stdout.indexOf('    fay, Jan 1 1970 00:00 UTC: "ok, let me check"');
		const back = r.stdout.indexOf('    fay, Jan 1 1970 00:00 UTC, a question: "staging or live?\\nlive is 906"');
		assert.ok(ack > 0 && back > ack, r.stdout);
		assert.match(
			r.stdout,
			/^It waits on desk\. abso reply 7 "\.\.\." adds to it; abso answer 7 "\.\.\." answers and closes it\.$/m,
		);
		// The asker reads it as their turn, and can't answer it.
		const desk = await folder("desk");
		const d = await main(["ask", "7"], { cwd: desk, env: ENV(), write: () => {} });
		assert.match(d.stdout, /^It waits on you\. abso reply 7 "\.\.\." adds to it\.$/m);
	});

	it("waiting --asked lists the asks you sent, open first, then the latest answered", async () => {
		const fay = await folder("fay");
		const before = seen.length;
		const r = await main(["waiting", "--asked"], { cwd: fay, env: ENV(), write: () => {} });
		assert.equal(r.exit, 0, r.stdout + r.stderr);
		assert.match(seen.slice(before).join("\n"), /^GET \/p\/issues\d+\/a\/fay\/asked$/m);
		assert.match(r.stdout, /^1 open ask you sent:$/m);
		assert.match(r.stdout, /^ {4}last: fay, .*, a question: "staging or live\? \.\.\."$/m);
		assert.ok(r.stdout.indexOf("ask 7:") < r.stdout.indexOf("The latest answered:"), r.stdout);
		assert.ok(r.stdout.indexOf("The latest answered:") < r.stdout.indexOf("ask 8:"), r.stdout);
		assert.match(r.stdout, /^ {4}answer: "yes"$/m);
	});

	it("an acknowledged ask reads as acknowledged, not answered, with the note under it", () => {
		const ask = {
			id: 7,
			issue: 3,
			by: "desk",
			of: "fay",
			kind: "question",
			question: "Which way?",
			review: false,
			due: null,
			recommendation: null,
			options: [],
			blocks: [],
			at: 0,
			answer: null,
			seen: 0,
			ack: { at: 0, note: "on it after the deploy" },
		};
		const page = {
			issue: {
				id: 3,
				title: "t",
				status: "blocked",
				parent: null,
				opened: { by: "desk", at: 0 },
				agent: null,
				agents: [],
				blockedBy: [],
				labels: [],
				versions: [],
				waitingOn: ["fay"],
				closed: null,
				description: "",
				lines: null,
				watchers: [],
			},
			comments: [],
			edits: [],
			asks: [ask],
			claims: [],
			children: [],
		} as unknown as IssuePage;
		const text = issuePage(page).join("\n");
		assert.match(
			text,
			/\n {2}ask 7: desk, [^\n]*asks fay a question on issue 3 \(acknowledged [^;)]+, not answered yet\): "Which way\?"\n {4}fay acknowledged: "on it after the deploy"/,
		);
		assert.doesNotMatch(text, /answer:/);
		const answered = { ...ask, answer: { by: "fay", words: "This way", at: 0 } };
		const later = issuePage({ ...page, asks: [answered] } as unknown as IssuePage).join("\n");
		assert.doesNotMatch(later, /acknowledged/, "an answer replaces the ack");
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
				`  "Pull is slow", done (description edited when copied)`,
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
