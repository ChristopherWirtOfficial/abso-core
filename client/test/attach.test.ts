// --attach (abso issue 171): images go up to the Issues Worker before the
// write that carries them, and the issue's page lists them. The Issues server
// here is a stand-in that keeps what it was sent.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { issuePage } from "../src/issues.ts";
import type { IssuePage } from "../src/issues-wire.ts";
import { main } from "../src/main.ts";
import { type Fake, startFake } from "./fake-server.ts";

const TOKEN = "test-token-not-secret";
let fake: Fake;
let issues: Server;
let issuesUrl: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] =
	[];
const dirs: string[] = [];

before(async () => {
	fake = await startFake(0, TOKEN);
	issues = createServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => parts.push(c));
		req.on("end", () => {
			const body = Buffer.concat(parts);
			seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
			const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
			// A server from before attachments: it reads every POST body as JSON.
			if (req.url!.includes("/p/old") && req.url!.endsWith("/attachments"))
				return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"the body is JSON"}');
			if (req.url!.endsWith("/attachments"))
				return json({
					id: `a${String(seen.length).padStart(12, "0")}`,
					name: "x",
					type: "image/png",
					size: body.length,
				});
			if (req.url!.endsWith("/issue")) return json({ id: 7 });
			if (/\/issue\/\d+\/comment$/.test(req.url!)) return json({ id: 3 });
			res.writeHead(404).end("{}");
		});
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

async function avcs(cwd: string, argv: string[]): Promise<{ exit: number; out: string; json?: unknown }> {
	const r = await main([...argv, "--json"], { cwd, env: ENV(), write: () => {} });
	let json: unknown;
	try {
		json = JSON.parse(r.stdout);
	} catch {}
	return { exit: r.exit, out: r.stdout + r.stderr, json };
}

let n = 0;
async function folder(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "abso-attach-"));
	dirs.push(dir);
	const r = await avcs(dir, ["init", "--server", fake.url, "--project", `attach${++n}`, "--agent", "ann"]);
	assert.equal(r.exit, 0, r.out);
	writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
	writeFileSync(join(dir, "after.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5]));
	return dir;
}

describe("--attach (abso issue 171)", () => {
	it("uploads each file, then opens the issue carrying their ids", async () => {
		const dir = await folder();
		const from = seen.length;
		const r = await avcs(dir, ["issue", "new", "The page after the fix", "--attach", "shot.png,after.png"]);
		assert.equal(r.exit, 0, r.out);
		const calls = seen.slice(from);
		assert.deepEqual(
			calls.map((c) => `${c.method} ${c.url.replace(/^\/p\/[^/]+/, "")}`),
			["POST /a/ann/attachments", "POST /a/ann/attachments", "POST /a/ann/issue"],
		);
		assert.equal(calls[0]!.headers["x-avcs-name"], "shot.png");
		assert.equal(calls[0]!.headers["content-type"], "application/octet-stream");
		assert.deepEqual([...calls[0]!.body], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const opened = JSON.parse(calls[2]!.body.toString()) as { title: string; attachments: string[] };
		assert.equal(opened.title, "The page after the fix");
		assert.equal(opened.attachments.length, 2);
		assert.deepEqual((r.json as { attachments: string[] }).attachments, opened.attachments);
	});

	it("goes on a comment too, and nowhere else", async () => {
		const dir = await folder();
		const from = seen.length;
		const r = await avcs(dir, ["issue", "7", "--comment", "after", "--attach", "shot.png"]);
		assert.equal(r.exit, 0, r.out);
		const comment = JSON.parse(seen.at(-1)!.body.toString()) as { text: string; attachments: string[] };
		assert.equal(comment.text, "after");
		assert.equal(comment.attachments.length, 1);
		assert.equal(seen.length - from, 2);
		const alone = await avcs(dir, ["issue", "7", "--attach", "shot.png"]);
		assert.equal(alone.exit, 1);
		assert.match(alone.out, /--attach goes with abso issue new or --comment/);
	});

	it("says plainly when the server doesn't take attachments yet, and writes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abso-attach-"));
		dirs.push(dir);
		const init = await avcs(dir, ["init", "--server", fake.url, "--project", "old", "--agent", "ann"]);
		assert.equal(init.exit, 0, init.out);
		writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
		const from = seen.length;
		const r = await avcs(dir, ["issue", "new", "T", "--attach", "shot.png"]);
		assert.equal(r.exit, 1);
		assert.match(r.out, /doesn't take attachments yet, so shot.png wasn't sent and nothing was written/);
		assert.deepEqual(
			seen.slice(from).map((c) => c.url.replace(/^\/p\/[^/]+/, "")),
			["/a/ann/attachments"],
			"no issue was opened",
		);
	});

	it("sends nothing when a file is missing", async () => {
		const dir = await folder();
		const from = seen.length;
		const r = await avcs(dir, ["issue", "new", "T", "--attach", "shot.png,nope.png"]);
		assert.equal(r.exit, 1);
		assert.match(r.out, /--attach nope.png: no such file/);
		assert.equal(seen.length, from);
	});

	it("an issue's page lists its attachments and each comment's, with links", () => {
		const page = {
			issue: {
				id: 7,
				title: "T",
				status: "open",
				opened: { by: "ann", at: 0 },
				agent: null,
				agents: [],
				blockedBy: [],
				labels: [],
				versions: [],
				waitingOn: [],
				parent: null,
				children: 0,
				updated: 0,
				closed: null,
				description: "",
				lines: null,
				watchers: [],
				attachments: [{ id: "a0123456789ab", name: "shot.png", type: "image/png", size: 2048 }],
			},
			comments: [
				{
					id: 1,
					by: "bob",
					kind: "comment",
					text: "same here",
					at: 0,
					attachments: [
						{ id: "a00000000000f", name: "mine.png", type: "image/png", size: 3 * 1024 * 1024 },
						{
							id: "a0000000000aa",
							name: "logo.png",
							type: "image/png",
							size: 4096,
							source: { name: "logo.svg", size: 512 },
						},
					],
				},
			],
			edits: [],
			asks: [],
			claims: [],
			children: [],
		} as unknown as IssuePage;
		const text = issuePage(page, {
			attachmentUrl: (id: string) => `https://issues.example/p/x/attachments/${id}`,
		}).join("\n");
		assert.match(
			text,
			/attached a0123456789ab: "shot.png", 2 KB, https:\/\/issues.example\/p\/x\/attachments\/a0123456789ab/,
		);
		assert.match(text, /\n {4}attached a00000000000f: "mine.png", 3.0 MB/);
		// An SVG is listed as its PNG, with its own file as a download beside it.
		assert.match(
			text,
			/\n {4}attached a0000000000aa: "logo.png", 4 KB, \S+\/a0000000000aa\n {6}drawn from "logo.svg", 512 B, https:\/\/issues.example\/p\/x\/attachments\/a0000000000aa\/source/,
		);
	});
});
