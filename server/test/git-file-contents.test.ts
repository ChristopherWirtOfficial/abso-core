import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import git from "isomorphic-git";
import { GitFileContents } from "../src/git-file-contents.ts";
import { MemoryFS } from "../src/memory-fs.ts";
import { memoryStorage } from "./helpers.ts";

test("Git writes and reads exact objects while filesystem entries retain no content bytes", async (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	using contents = new GitFileContents(storage, 1000000, 10000000);
	const fs = new MemoryFS(contents),
		dir = "/repo";
	await git.init({ fs, dir, defaultBranch: "main" });
	const entries = [],
		bodies: Uint8Array[] = [];
	for (let index = 0; index < 20; index++) {
		const body = randomBytes(70000);
		bodies.push(body);
		entries.push({
			mode: "100644",
			path: `file-${index}`,
			oid: await git.writeBlob({ fs, dir, blob: body }),
			type: "blob" as const,
		});
	}
	const tree = await git.writeTree({ fs, dir, tree: entries });
	const commit = await git.commit({
		fs,
		dir,
		tree,
		parent: [],
		message: "Scratch fixture",
		author: { name: "Fixture", email: "fixture@example.invalid" },
	});
	for (let index = 0; index < 20; index++) {
		const blob = await git.readBlob({ fs, dir, oid: commit, filepath: `file-${index}` });
		assert.deepEqual(new Uint8Array(blob.blob), new Uint8Array(bodies[index]!));
	}
	for (const entry of fs.entries.values()) if (entry.kind === "file") assert.equal(entry.data.byteLength, 0);
	assert.ok(Number(storage.db.prepare("SELECT MAX(length(data)) AS n FROM git_fs_chunks").get()!.n) <= 65536);
	const reference = "/repo/.git/refs/heads/main";
	assert.equal((await fs.stat(reference)).size, ((await fs.readFile(reference)) as Uint8Array).byteLength);
});

test("Git scratch replacement failure preserves old contents, metadata and budget", async (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	using contents = new GitFileContents(storage, 100000, 150000);
	const fs = new MemoryFS(contents);
	await fs.writeFile("/file", new Uint8Array([7]));
	const exec = storage.sql.exec.bind(storage.sql);
	const failure = t.mock.method(storage.sql, "exec", (query: string, ...bindings: unknown[]) => {
		if (query.startsWith("INSERT INTO git_fs_chunks") && bindings[2] === 1) throw Error("injected chunk failure");
		return exec(query, ...bindings);
	});
	await assert.rejects(() => fs.writeFile("/file", new Uint8Array(70000)), /injected chunk failure/);
	assert.deepEqual(await fs.readFile("/file"), new Uint8Array([7]));
	assert.equal((await fs.stat("/file")).size, 1);
	assert.equal(storage.db.prepare("SELECT bytes FROM git_fs_budget").get()!.bytes, 1);
	failure.mock.restore();
	await fs.writeFile("/file", new Uint8Array(70000));
	await assert.rejects(() => fs.writeFile("/other", new Uint8Array(90000)), /total byte limit/);
	await assert.rejects(() => fs.stat("/other"), /ENOENT/);
	await fs.unlink("/file");
	assert.equal(storage.db.prepare("SELECT bytes FROM git_fs_budget").get()!.bytes, 0);
});

test("cold Git file recovery preserves canonical rows and active scopes dispose independently", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	storage.sql.exec("CREATE TABLE canonical_fs_fixture (value TEXT)");
	storage.sql.exec("INSERT INTO canonical_fs_fixture VALUES ('preserved')");
	const first = new GitFileContents(storage, 10, 20),
		second = new GitFileContents(storage, 10, 20);
	first.write("/a", new Uint8Array([1]));
	second.write("/b", new Uint8Array([2]));
	first.dispose();
	assert.deepEqual(second.read("/b"), new Uint8Array([2]));
	GitFileContents.recover(storage);
	GitFileContents.recover(storage);
	for (const table of ["git_fs_meta", "git_fs_chunks", "git_fs_budget"])
		assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
	assert.equal(storage.db.prepare("SELECT value FROM canonical_fs_fixture").get()!.value, "preserved");
	assert.throws(() => second.read("/b"), /invalid Git scratch file/);
	second.dispose();
});
