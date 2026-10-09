// Files kept whole (#46, ruled on #43): paths matching
// avcs.json's "whole", and any text over 1 MB, are stored like binary files:
// whole versions in the blob store, no line ids, so a large generated file
// can't fill the project's memory. Once whole, a file stays whole while it
// exists, so it never flips back and forth.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

function setup(config: object = { whole: ["test/recordings/**"] }) {
	const store = new Map<string, string>();
	const whole = {
		keep: (text: string) => {
			const sha = createHash("sha256").update(text, "utf8").digest("hex");
			store.set(sha, text);
			return sha;
		},
		read: (sha: string) => store.get(sha) ?? null,
	};
	const log = new MemoryStore();
	const project = new Project(log, { hasBlob: (sha) => store.has(sha), whole });
	project.init({ "avcs.json": JSON.stringify(config) + "\n", "src/a.ts": "export const a = 1;\n" }, 0);
	for (const a of ["ann", "bob"]) project.sync(a);
	return { project, store, log, whole };
}

const recording = (n: number) =>
	JSON.stringify({ frames: Array.from({ length: 50 }, (_, i) => i * n) }, null, 2) + "\n";

test("a path the project marks whole is stored as a blob, and publishes and syncs like one", () => {
	const { project, store } = setup();
	const r = project.record("ann", { "test/recordings/one.json": recording(1) }, 1);
	assert.deepEqual(r.changed, ["test/recordings/one.json"]);
	const p = project.publish("ann", "a recording", 2);
	assert.ok(p.ok);
	const blob = project.blobs()["test/recordings/one.json"];
	assert.equal(typeof blob, "string");
	assert.equal(store.get(blob as string), recording(1));
	// The graph holds no lines for it: blame has nothing to say, the file text in views is empty.
	assert.equal(project.files()["test/recordings/one.json"] ?? "", "");
});

test("text over 1 MB is kept whole whatever its path; smaller text is tracked by line", () => {
	const { project } = setup({});
	const big = "x".repeat(80) + "\n";
	project.record("ann", { "gen/big.txt": big.repeat(13_000), "src/small.txt": "small\n" }, 1);
	project.publish("ann", "two files", 2);
	assert.ok(project.blobs()["gen/big.txt"], "the big one is a blob");
	assert.equal(project.blobs()["src/small.txt"], undefined);
	assert.equal(project.files()["src/small.txt"], "small\n");
});

test("once whole, a file stays whole even when it shrinks; an Edit of it is out of step so the client sends the file", () => {
	const { project, store } = setup({});
	project.record("ann", { "gen/big.txt": ("y".repeat(80) + "\n").repeat(13_000) }, 1);
	project.publish("ann", "big", 2);
	project.sync("bob");
	project.record("bob", { "gen/big.txt": "tiny now\n" }, 3);
	project.publish("bob", "shrink", 4);
	const sha = project.blobs()["gen/big.txt"]!;
	assert.equal(store.get(sha), "tiny now\n");
	assert.deepEqual(project.edit("bob", { file: "gen/big.txt", old: "tiny", new: "small" }, 5), {
		ok: false,
		reason: "out of step",
	});
	// A Write is recorded whole.
	assert.equal(project.edit("bob", { file: "gen/big.txt", content: "written\n" }, 6).ok, true);
	project.publish("bob", "write", 7);
	assert.equal(store.get(project.blobs()["gen/big.txt"]!), "written\n");
});

test("init keeps whole the paths its own avcs.json names; without a store nothing is kept whole", () => {
	const store = new Map<string, string>();
	const whole = {
		keep: (t: string) => {
			const sha = createHash("sha256").update(t, "utf8").digest("hex");
			store.set(sha, t);
			return sha;
		},
		read: (s: string) => store.get(s) ?? null,
	};
	const project = new Project(new MemoryStore(), { hasBlob: (s) => store.has(s), whole });
	project.init({ "avcs.json": '{"whole": ["rec/**"]}\n', "rec/a.json": "{}\n", "b.ts": "b\n" }, 0);
	assert.ok(project.blobs()["rec/a.json"]);
	const plain = new Project(new MemoryStore());
	plain.init({ "avcs.json": '{"whole": ["rec/**"]}\n', "rec/a.json": "{}\n" }, 0);
	assert.equal(plain.files()["rec/a.json"], "{}\n", "no store: tracked by line as before");
});

test("a whole project's memory stays small: 20 re-recordings of a 60,000-line file add no lines to the graph", () => {
	const { project, log } = setup();
	const big = (n: number) =>
		JSON.stringify({ frames: Array.from({ length: 20_000 }, (_, i) => ({ i, v: i % 50 === 0 ? n : 0 })) }, null, 2) +
		"\n";
	for (let n = 0; n < 20; n++) {
		project.record(n % 2 ? "ann" : "bob", { "test/recordings/big.json": big(n) }, n + 1);
		project.publish(n % 2 ? "ann" : "bob", `rec ${n}`, n + 1);
		project.sync(n % 2 ? "bob" : "ann");
	}
	const size = JSON.stringify(log.entries).length;
	assert.ok(size < 200_000, `log is ${size} characters: only hashes, no lines`);
});
