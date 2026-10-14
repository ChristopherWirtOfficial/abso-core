import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pushShared } from "../src/push.ts";
import { memoryStorage } from "./helpers.ts";

test("disk export streams to real Git receive-pack and preserves remote ancestry", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "abso-export-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "fixture.git");
	const command = (...args: string[]) => execFileSync("git", args);
	command("init", "--bare", "--initial-branch=main", repo);
	command("--git-dir", repo, "config", "http.receivepack", "true");
	let uploads = 0;
	let rejectClone = false;
	const server = createServer((request, response) => {
		const url = new URL(request.url!, "http://fixture.invalid");
		if (rejectClone && url.pathname.endsWith("git-upload-pack")) {
			response.writeHead(503).end("injected upload-pack failure");
			return;
		}
		if (url.pathname.endsWith("git-receive-pack")) uploads++;
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method!,
				CONTENT_TYPE: request.headers["content-type"] ?? "",
				REMOTE_USER: "fixture",
				SERVER_PROTOCOL: "HTTP/1.1",
			},
		});
		request.pipe(child.stdin);
		let headers = Buffer.alloc(0),
			started = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (started) {
				response.write(chunk);
				return;
			}
			headers = Buffer.concat([headers, chunk]);
			const boundary = headers.indexOf("\r\n\r\n");
			if (boundary < 0) return;
			for (const line of headers.subarray(0, boundary).toString().split("\r\n")) {
				const colon = line.indexOf(":");
				const key = line.slice(0, colon),
					value = line.slice(colon + 1).trim();
				if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]);
				else response.setHeader(key, value);
			}
			started = true;
			response.write(headers.subarray(boundary + 4));
			headers = Buffer.alloc(0);
		});
		child.stdout.on("end", () => response.end());
		child.on("error", (error) => response.destroy(error));
		child.stderr.resume();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address() as { port: number };
	const remote = `http://127.0.0.1:${address.port}/fixture.git`;
	const artifacts = {
		get: async () => ({
			info: async () => ({ remote }),
			createToken: async () => ({ plaintext: "synthetic-token" }),
			[Symbol.dispose]() {},
		}),
	};
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const disk = { storage, maxPackBytes: 8000000, maxObjectBytes: 4000000, maxDecodedBytes: 16000000 };
	const binary = randomBytes(1500000);
	const first = await pushShared(
		artifacts as never,
		"fixture",
		{
			version: 1,
			files: { "a.txt": "first\n" },
			blobs: { "large.bin": "binary" },
		},
		() => binary,
		disk,
	);
	const second = await pushShared(
		artifacts as never,
		"fixture",
		{
			version: 2,
			files: { "a.txt": "second\n", "new.txt": "new\n" },
			blobs: { "large.bin": "binary" },
		},
		() => binary,
		disk,
	);
	assert.equal(command("--git-dir", repo, "rev-parse", "main^").toString().trim(), first.commit);
	assert.equal(command("--git-dir", repo, "rev-parse", "main").toString().trim(), second.commit);
	assert.equal(command("--git-dir", repo, "show", "main:a.txt").toString(), "second\n");
	assert.deepEqual(execFileSync("git", ["--git-dir", repo, "show", "main:large.bin"], { maxBuffer: 4000000 }), binary);
	assert.equal(uploads, 2);
	rejectClone = true;
	await assert.rejects(() =>
		pushShared(artifacts as never, "fixture", { version: 3, files: { "bad.txt": "must not push" } }, undefined, disk),
	);
	assert.equal(uploads, 2, "failed clone must never become an empty-repository push");
	for (const table of [
		"git_fs_chunks",
		"git_fs_meta",
		"git_fs_budget",
		"git_pack_spool",
		"git_pack_resolve",
		"git_object_bytes",
		"git_object_meta",
		"git_object_budget",
	])
		assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
});
