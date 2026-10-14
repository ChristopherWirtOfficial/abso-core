// Where asks every agent for its draft, and a big project has more agents than
// the view cache holds (32). An agent's view is laid out only when it's read,
// so agents with no changes cost nothing, and the answer stays what it was.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";
import { where } from "../where.ts";

test("where does not construct shared history when every draft is empty", (t) => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "one\n" }, 0);
	project.sync("idle");
	t.mock.method(project, "sharedView", () => {
		throw Error("unnecessary shared history construction");
	});
	assert.deepEqual(where(project), { version: 0, files: {}, starting: [] });
});

test("where answers right with more agents than the view cache holds, and lays out no view for an empty draft", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.ts": "one\ntwo\nthree\n" }, 0);
	for (let i = 0; i < 40; i++) project.sync(`idle-${i}`);
	project.edit("busy", { file: "a.ts", old: "two\n", new: "two!\n" }, 1);

	const answer = where(project);
	assert.deepEqual(Object.keys(answer.files), ["a.ts"]);
	assert.deepEqual(
		answer.files["a.ts"]!.map((s) => [s.agent, s.lines, s.changes]),
		[["busy", [[2, 2]], 1]],
	);
	assert.deepEqual(where(Project.load(store.entries, new MemoryStore())), answer);

	const idle = project.draftOf("idle-0")!;
	assert.deepEqual(idle.atoms, []);
	assert.equal(typeof Object.getOwnPropertyDescriptor(idle, "view")?.get, "function");
	assert.equal(idle.view.text("a.ts"), "one\ntwo\nthree\n");
});
