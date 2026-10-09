// The project file's new name (224): abso.json is read first, then avcs.json
// from before the rename. Both are checked the same way, and when shared has
// both, abso.json counts and status says avcs.json is ignored.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const review = (reviewer: string) => JSON.stringify({ review: [{ paths: ["src/**"], reviewer }] }) + "\n";

function touchSrc(project: Project, time: number): void {
	project.sync("builder");
	const a = project.edit("builder", { file: "src/a.ts", old: `${time - 1}`, new: `${time}` }, time);
	if (!a.ok) throw new Error("edit out of step");
	project.publish("builder", `a ${time}`, time + 1);
}

test("abso.json alone is the project file: its reviewers are told", () => {
	const project = new Project(new MemoryStore(), { now: () => 100 });
	project.init({ "abso.json": review("security"), "src/a.ts": "export const a = 0;\n" }, 0);
	project.sync("security");
	touchSrc(project, 1);
	assert.equal(project.news("security").news.length, 1);
	assert.equal(project.status().projectFile, undefined, "one file: nothing to say");
});

test("avcs.json alone still works", () => {
	const project = new Project(new MemoryStore(), { now: () => 100 });
	project.init({ "avcs.json": review("security"), "src/a.ts": "export const a = 0;\n" }, 0);
	project.sync("security");
	touchSrc(project, 1);
	assert.equal(project.news("security").news.length, 1);
});

test("with both, abso.json counts and status says avcs.json is ignored", () => {
	const project = new Project(new MemoryStore(), { now: () => 100 });
	project.init(
		{ "abso.json": review("security"), "avcs.json": review("writer"), "src/a.ts": "export const a = 0;\n" },
		0,
	);
	for (const a of ["security", "writer"]) project.sync(a);
	touchSrc(project, 1);
	assert.equal(project.news("security").news.length, 1);
	assert.equal(project.news("writer").news.length, 0, "avcs.json is ignored");
	assert.deepEqual(project.status().projectFile, { used: "abso.json", ignored: "avcs.json" });
});

test("a broken abso.json is refused like a broken avcs.json, at publish and at init", () => {
	const project = new Project(new MemoryStore());
	project.init({ "abso.json": '{"queue": false}\n' }, 0);
	project.sync("alice");
	project.record("alice", { "abso.json": '{"queue": "yes"}\n' }, 1);
	assert.throws(() => project.publish("alice", "queue as text", 2), /abso\.json has "queue" that isn't true or false/);
	assert.equal(project.files()["abso.json"], '{"queue": false}\n', "shared keeps the good one");
	// A broken avcs.json is still refused when abso.json is there too: it may be read again once abso.json goes.
	project.record("alice", { "abso.json": '{"queue": false}\n', "avcs.json": "[1]\n" }, 3);
	assert.throws(() => project.publish("alice", "old file broken", 4), /avcs\.json must be a JSON object/);
	assert.throws(
		() => new Project(new MemoryStore()).init({ "abso.json": "[1]\n" }, 0),
		/init: abso\.json must be a JSON object/,
	);
});

test(".abso/ stays in the agent's folder, like .avcs/", () => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "a\n" }, 0);
	for (const p of [".abso/config.json", "sub/.ABSO/x", ".avcs/config.json"]) {
		assert.throws(() => project.record("ann", { [p]: "x\n" }, 1), /is under \.(abso|avcs)\//, p);
	}
	assert.equal(project.record("ann", { ".absolutely.txt": "x\n" }, 1) !== undefined, true);
});
