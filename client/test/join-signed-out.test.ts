// A join with no sign-in says abso login signs the box in. For a public project
// it also says where the website shows it, since the client needs a sign-in
// even to read. The client runs as its own process with an empty home, so no
// sign-in or token on this machine is found.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Fake, startFake } from "./fake-server.ts";

const CLIENT = resolve(import.meta.dirname, "..", "abso.ts");
let fake: Fake;
// A server where every project is public: status answers signed out, and the agent routes want a sign-in.
let open: Server;
let openUrl: string;
const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "abso-test-signed-out-"));
	dirs.push(dir);
	return dir;
};

before(async () => {
	fake = await startFake(0, "test-token-not-secret");
	open = createServer((req, res) => {
		if (req.method === "GET" && /^\/p\/[^/]+\/status$/.test(req.url ?? ""))
			return res.writeHead(200, { "content-type": "application/json" }).end('{"version":1,"agents":[]}');
		res.writeHead(401, { "content-type": "application/json" }).end('{"error":"sign in"}');
	});
	await new Promise<void>((done) => open.listen(0, "127.0.0.1", done));
	openUrl = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
});
after(async () => {
	await fake.close();
	open.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs the client signed out: an empty home, and no token in the environment. */
function signedOut(...args: string[]): Promise<{ code: number; stderr: string }> {
	const home = temp();
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		AVCS_SERVERS_FILE: "no-servers.json",
	};
	if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	return new Promise((done) => {
		execFile(process.execPath, [CLIENT, ...args], { cwd: temp(), env }, (error, _stdout, stderr) =>
			done({ code: typeof error?.code === "number" ? error.code : 0, stderr }),
		);
	});
}

describe("join, signed out", () => {
	it("to a public project, as a reader, names its page on the website and abso login", async () => {
		const run = await signedOut("join", "abso-core", "--agent", "qa-reader", "--reader", "--server", openUrl);
		assert.notEqual(run.code, 0);
		assert.match(
			run.stderr,
			/abso-core is public: read it at http:\/\/127\.0\.0\.1:\d+\/christopher\/abso-core \(every page is also JSON\)\. The client needs a sign-in, even to read: abso login\./,
		);
	});

	it("to a project that isn't public, keeps to abso login, and says a folder with a key joins with --agent", async () => {
		const run = await signedOut("join", "secret", "--server", fake.url);
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /isn't signed in to .*abso login signs it in\./);
		assert.doesNotMatch(run.stderr, /is public/);
		assert.match(run.stderr, /A folder that already has a key joins with --agent <name>/);
	});
});
