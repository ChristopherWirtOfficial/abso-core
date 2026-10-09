// --attach (abso issue 171): images go up to the Issues Worker before the
// write that carries them, and the issue's page lists them. The Issues server
// here is a stand-in that keeps what it was sent.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			// An older Issues server keeps no files on asks: it answers without them (project "keepless").
			const older = req.url!.includes("/p/keepless/");
			if (req.url!.endsWith("/ask")) {
				const sent = (JSON.parse(body.toString()) as { attachments?: string[] }).attachments;
				return json({ id: 9, ...(sent && !older ? { attachments: sent } : {}) });
			}
			if (/\/answer\/\d+$/.test(req.url!)) {
				const sent = (JSON.parse(body.toString()) as { attachments?: string[] }).attachments ?? [];
				const files = older ? [] : sent.map((id) => ({ id, name: "x", type: "image/png", size: 1 }));
				return json({ ask: { by: "bob", answer: { by: "ann", words: "w", at: 0, attachments: files } } });
			}
			// Issue 9's ask carries a file on its question and one on its answer.
			if (req.method === "GET" && /\/issue\/9$/.test(req.url!))
				return json({
					issue: { id: 9 },
					comments: [],
					edits: [],
					asks: [
						{
							attachments: [{ id: "a00000000000d", name: "question.png", type: "image/png", size: 13 }],
							answer: { attachments: [{ id: "a00000000000e", name: "answer.png", type: "image/png", size: 13 }] },
						},
					],
					claims: [],
					children: [],
				});
			// Issue 8 carries an svg-drawn image on itself and again on a comment, plus one more on the comment.
			const logo = { id: "a00000000000b", name: "../shot one.png", type: "image/png", size: 13 };
			if (req.method === "GET" && /\/issue\/8$/.test(req.url!))
				return json({
					issue: { id: 8, attachments: [{ ...logo, source: { name: "logo.svg", size: 20 } }] },
					comments: [{ attachments: [logo, { id: "a00000000000c", name: "after.png", type: "image/png", size: 13 }] }],
					edits: [],
					asks: [],
					claims: [],
					children: [],
				});
			const served = /\/attachments\/(a[0-9a-f]{12})(\/source)?$/.exec(req.url!);
			if (req.method === "GET" && served)
				return res.writeHead(200, { "content-type": "image/png" }).end(`${served[1]}${served[2] ?? ""}`);
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

	it("--save-attachments saves each attachment once, an svg's own file too, outside the folder", async () => {
		const dir = await folder();
		const out = mkdtempSync(join(tmpdir(), "abso-saved-"));
		dirs.push(out);
		const r = await avcs(dir, ["issue", "8", "--save-attachments", join(out, "images")]);
		assert.equal(r.exit, 0, r.out);
		const names = readdirSync(join(out, "images")).sort();
		assert.deepEqual(names, ["a00000000000b-logo.svg", "a00000000000b-shot_one.png", "a00000000000c-after.png"]);
		assert.equal(readFileSync(join(out, "images", "a00000000000b-logo.svg"), "utf8"), "a00000000000b/source");
		assert.equal(readFileSync(join(out, "images", "a00000000000c-after.png"), "utf8"), "a00000000000c");
		assert.equal((r.json as { files: unknown[] }).files.length, 3);
		// Into the folder only where abso leaves files out, or they'd be recorded as edits.
		const inside = await avcs(dir, ["issue", "8", "--save-attachments", "images"]);
		assert.equal(inside.exit, 1);
		assert.match(inside.out, /inside this abso folder/);
		assert.equal((await avcs(dir, ["issue", "8", "--save-attachments", "."])).exit, 1);
		writeFileSync(join(dir, ".absoignore"), "saved/\n");
		assert.equal((await avcs(dir, ["issue", "8", "--save-attachments", "saved"])).exit, 0);
		const mixed = await avcs(dir, ["issue", "8", "--save-attachments", out, "--comment", "x"]);
		assert.equal(mixed.exit, 1);
		assert.match(mixed.out, /--save-attachments goes alone/);
	});

	it("goes on an ask and on an answer, and not on a withdrawal", async () => {
		const dir = await folder();
		let from = seen.length;
		const asked = await avcs(dir, [
			"ask",
			"bob",
			"Which looks right?",
			"--issue",
			"7",
			"--attach",
			"shot.png,after.png",
		]);
		assert.equal(asked.exit, 0, asked.out);
		assert.deepEqual(
			seen.slice(from).map((c) => `${c.method} ${c.url.replace(/^\/p\/[^/]+/, "")}`),
			["POST /a/ann/attachments", "POST /a/ann/attachments", "POST /a/ann/ask"],
		);
		const ask = JSON.parse(seen.at(-1)!.body.toString()) as { question: string; attachments: string[] };
		assert.equal(ask.question, "Which looks right?");
		assert.equal(ask.attachments.length, 2);
		assert.deepEqual((asked.json as { attachments: string[] }).attachments, ask.attachments);
		from = seen.length;
		const answered = await avcs(dir, ["answer", "9", "This one", "--attach", "after.png"]);
		assert.equal(answered.exit, 0, answered.out);
		const answer = JSON.parse(seen.at(-1)!.body.toString()) as { words: string; attachments: string[] };
		assert.equal(answer.words, "This one");
		assert.equal(answer.attachments.length, 1);
		assert.equal(seen.length - from, 2);
		from = seen.length;
		const withdrawn = await avcs(dir, ["ask", "--withdraw", "9", "--attach", "shot.png"]);
		assert.equal(withdrawn.exit, 1);
		assert.equal(seen.length, from, "nothing was sent");
	});

	it("says so when an older Issues server keeps an ask's words but not its files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abso-attach-"));
		dirs.push(dir);
		const init = await avcs(dir, ["init", "--server", fake.url, "--project", "keepless", "--agent", "ann"]);
		assert.equal(init.exit, 0, init.out);
		writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
		const asked = await avcs(dir, ["ask", "bob", "Which?", "--attach", "shot.png"]);
		assert.equal(asked.exit, 0, asked.out);
		assert.match(asked.out, /didn't keep the file on ask 9: it is older than this client/);
		const answered = await avcs(dir, ["answer", "9", "This", "--attach", "shot.png"]);
		assert.match(answered.out, /didn't keep the file on your answer to ask 9/);
		// A server that keeps them says nothing of the kind.
		const kept = await avcs(await folder(), ["ask", "bob", "Which?", "--attach", "shot.png"]);
		assert.doesNotMatch(kept.out, /didn't keep/);
	});

	it("--save-attachments takes the files on an issue's asks and answers too", async () => {
		const dir = await folder();
		const out = mkdtempSync(join(tmpdir(), "abso-saved-"));
		dirs.push(out);
		const r = await avcs(dir, ["issue", "9", "--save-attachments", out]);
		assert.equal(r.exit, 0, r.out);
		assert.deepEqual(readdirSync(out).sort(), ["a00000000000d-question.png", "a00000000000e-answer.png"]);
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
		// The way in comes before the first link, since an agent's fetch of a link is refused.
		assert.match(
			text,
			/^Issue [^\n]*\n[^\n]*\n3 files are attached below\. To read them: abso issue \d+ --save-attachments <folder> saves every one there, then open the files\. The links are for people signed in on the website\.\n/,
		);
		assert.doesNotMatch(
			issuePage({ ...page, issue: { ...page.issue, attachments: [] }, comments: [] } as unknown as IssuePage).join(
				"\n",
			),
			/--save-attachments/,
		);
		// An SVG is listed as its PNG, with its own file as a download beside it.
		assert.match(
			text,
			/\n {4}attached a0000000000aa: "logo.png", 4 KB, \S+\/a0000000000aa\n {6}drawn from "logo.svg", 512 B, https:\/\/issues.example\/p\/x\/attachments\/a0000000000aa\/source/,
		);
		// An ask lists its question's files under it, and its answer's under the answer.
		const file = (id: string, name: string) => ({ id, name, type: "image/png", size: 1024 });
		const asked = {
			...page,
			asks: [
				{
					id: 4,
					issue: 7,
					by: "ann",
					of: "bob",
					kind: "question",
					question: "Which?",
					attachments: [file("a00000000000d", "a.png")],
					review: false,
					due: null,
					recommendation: null,
					options: [],
					blocks: [],
					at: 0,
					answer: { by: "bob", words: "This", at: 0, attachments: [file("a00000000000e", "b.png")] },
					seen: null,
				},
			],
		} as unknown as IssuePage;
		const asks = issuePage(asked, { attachmentUrl: (id: string) => `https://i.example/${id}` }).join("\n");
		assert.match(asks, /\n5 files are attached below\./, "an ask's question and answer files count too");
		assert.match(
			asks,
			/ask 4: .*"Which\?"\n {4}attached a00000000000d: "a.png", 1 KB, https:\/\/i.example\/a00000000000d\n {4}answer: "This"\n {6}attached a00000000000e: "b.png", 1 KB/,
		);
	});
});
