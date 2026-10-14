import assert from "node:assert/strict";
import { test } from "node:test";
import { GitIntakeTrees } from "../src/git-intake-trees.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("unchanged Git blobs share stored text across paths and commits", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const trees = new GitIntakeTrees(storage);
	const body = "unchanged\n".repeat(10000);
	const oid = "a".repeat(40);
	const count = () =>
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get(trees.namespace)!.n;
	const first: Record<string, string> = {};
	trees.retainFile(first, "original", body, oid);
	const initialRows = count();
	for (let i = 0; i < 100; i++) {
		const files: Record<string, string> = {};
		trees.retainFile(files, `renamed-${i}`, body, oid);
		assert.equal(files[`renamed-${i}`], body);
	}
	assert.equal(count(), initialRows);
	trees.retainFile(first, "changed", "new text", "b".repeat(40));
	assert.equal(first.original, body);
	assert.equal(first.changed, "new text");
	assert.ok(Number(count()) > Number(initialRows));
	assert.throws(() => trees.retainFile(first, "bad", "text", "bad-id"), /Invalid Git blob id/);
	trees.dispose();
	assert.equal(count(), 0);
});

test("Git intake stores each decoded file before the next file arrives", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const trees = new GitIntakeTrees(storage);
	const files: Record<string, string> = Object.create(null);
	for (let i = 0; i < 20; i++) {
		trees.retainFile(files, `file-${i}`, `${i}:${"x".repeat(50000)}`);
		assert.equal(Object.getOwnPropertyDescriptor(files, `file-${i}`)?.value, undefined);
		assert.equal(files[`file-${i}`], `${i}:${"x".repeat(50000)}`);
	}
	assert.equal(Object.keys(files).length, 20);
	trees.dispose();
	assert.throws(() => files["file-0"], /closed/);
	assert.throws(() => trees.retainFile(files, "later", "text"), /closed/);
});

test("Git intake retains independent trees on disk and releases their text rows", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const trees = new GitIntakeTrees(storage);
	const retained: ReturnType<GitIntakeTrees["retain"]>[] = [];
	for (let i = 0; i < 50; i++) {
		const files = {
			"a.txt": `${i}:${"\ud83d\ude80".repeat(20000)}\n`,
			"empty.txt": "",
		};
		retained.push(
			trees.retain({
				files,
				modes: { "a.txt": { exec: true, link: null } },
				blobs: {},
			}),
		);
		files["a.txt"] = "changed after retention";
	}
	for (let i = 0; i < retained.length; i++) {
		const tree = retained[i]!;
		assert.deepEqual(Object.keys(tree.files), ["a.txt", "empty.txt"]);
		assert.equal(Object.getOwnPropertyDescriptor(tree.files, "a.txt")?.value, undefined);
		assert.equal(tree.files["a.txt"], `${i}:${"\ud83d\ude80".repeat(20000)}\n`);
		assert.equal(tree.files["empty.txt"], "");
		assert.equal(tree.modes["a.txt"]?.exec, true);
	}
	const count = () =>
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get(trees.namespace)!.n;
	assert.ok(Number(count()) > 0);
	trees.dispose();
	assert.equal(count(), 0);
	assert.throws(() => retained[0]!.files["a.txt"], /closed/);
	assert.throws(() => trees.retain({ files: {}, modes: {}, blobs: {} }), /closed/);
	trees.dispose();
});

test("disposing one intake does not delete another concurrent intake", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const first = new GitIntakeTrees(storage);
	const second = new GitIntakeTrees(storage);
	first.retain({ files: { a: "first" }, modes: {}, blobs: {} });
	const retained = second.retain({
		files: { a: "second" },
		modes: {},
		blobs: {},
	});
	first.dispose();
	assert.equal(retained.files.a, "second");
	second.dispose();
});

test("cold recovery removes abandoned intake text and preserves canonical writer state", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const abandoned = new GitIntakeTrees(storage);
	abandoned.retain({ files: { a: "abandoned text" }, modes: {}, blobs: {} });
	const canonical = new SqliteWriterState(storage, "server-disk-v1");
	canonical.write("receipt", "operation", { committed: true });
	GitIntakeTrees.recover(storage);
	assert.deepEqual(canonical.read("receipt", "operation"), { committed: true });
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get(abandoned.namespace)!.n,
		0,
	);
	const retry = new GitIntakeTrees(storage);
	assert.equal(retry.retain({ files: { a: "retry" }, modes: {}, blobs: {} }).files.a, "retry");
	retry.dispose();
});
