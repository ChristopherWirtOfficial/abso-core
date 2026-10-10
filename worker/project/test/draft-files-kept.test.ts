// Each agent's draft files are kept between calls (abso-core issue 6). Status
// must answer as a project that works them out cold does, after every kind of
// step, in shared and in a named draft.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const START = {
	"core.ts": "export function step(x: number) {\n  return x + 1;\n}\n\nexport const version = 1;\n",
	"notes.md": "one\ntwo\nthree\n",
};

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	for (const a of ["ann", "bob", "cat"]) project.sync(a);
	// Warm: every agent's draft files are kept from here on.
	project.status();
	return { project, store };
}

/** Status from the warm project, checked against the same log loaded cold. */
function same(project: Project, store: MemoryStore, step: string) {
	const warm = project.status();
	assert.deepEqual(warm, Project.load(store.entries, new MemoryStore()).status(), `after ${step}`);
	return warm;
}

const filesOf = (status: ReturnType<Project["status"]>, agent: string) =>
	status.agents.find((a) => a.agent === agent)!.files;

test("status answers the same warm and cold through records, pushes and pulls in shared", () => {
	const { project, store } = setup();
	project.edit("ann", { file: "core.ts", old: "  return x + 1;", new: "  return x + 2;" }, 1);
	assert.deepEqual(filesOf(same(project, store, "ann's edit"), "ann"), ["core.ts"]);
	project.edit("ann", { file: "notes.md", old: "two\n", new: "two!\n" }, 2);
	assert.deepEqual(filesOf(same(project, store, "ann's second edit"), "ann"), ["core.ts", "notes.md"]);
	project.edit("bob", { file: "notes.md", old: "three\n", new: "three!\n" }, 3);
	same(project, store, "bob's edit");
	project.publish("ann", "Ann's two", 4);
	assert.deepEqual(filesOf(same(project, store, "ann's push"), "ann"), []);
	project.sync("bob");
	assert.deepEqual(filesOf(same(project, store, "bob's pull"), "bob"), ["notes.md"]);
	project.record("cat", { "new.ts": "export {};\n" }, 5);
	assert.deepEqual(filesOf(same(project, store, "cat's new file"), "cat"), ["new.ts"]);
	project.publish("cat", "Cat's file", 6);
	same(project, store, "cat's push");
});

test("two agents in one named draft: one pushes, and the other's status still matches a cold load", () => {
	const { project, store } = setup();
	project.switchTo("ann", "rw", 1);
	project.switchTo("bob", "rw", 2);
	same(project, store, "both switch");
	project.edit("ann", { file: "core.ts", old: "  return x + 1;", new: "  return x * 2;" }, 3);
	project.edit("bob", { file: "notes.md", old: "one\n", new: "one (rw)\n" }, 4);
	const before = same(project, store, "both edit in rw");
	assert.deepEqual(filesOf(before, "bob"), ["notes.md"]);
	project.publish("ann", "Double", 5);
	const after = same(project, store, "ann pushes into rw");
	assert.deepEqual(filesOf(after, "ann"), []);
	project.sync("bob");
	assert.deepEqual(filesOf(same(project, store, "bob pulls in rw"), "bob"), ["notes.md"]);
	project.publish("bob", "Note", 6);
	assert.deepEqual(filesOf(same(project, store, "bob pushes into rw"), "bob"), []);
	project.land("ann", "Land rw", 7);
	same(project, store, "rw lands");
	project.switchTo("ann", "shared", 8);
	same(project, store, "ann back in shared");
});
