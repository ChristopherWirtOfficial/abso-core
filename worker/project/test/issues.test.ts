// Issues' hooks in the engine (#54): a start note can name an issue, the
// change record keeps it, changes(issue) lists the work on it, and starting()
// says what the Issues Worker should hear: a claim when a note names an
// issue, and an end (done after publish --done, with the version that
// finished it) when that note ends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	assert.ok(project.edit(agent, body, time).ok);
}

function setup() {
	const store = new MemoryStore();
	const project = new Project(store, { now: () => 100 });
	project.init({ "a.ts": "export const a = 1;\n" }, 0);
	for (const a of ["builder", "other"]) project.sync(a);
	return { project, store };
}

test("a note naming an issue claims it; push --done ends it as done, with the version", () => {
	const { project, store } = setup();
	const s = project.starting("builder", "Bigger a", ["a.ts"], 1, { issue: 12 });
	const at = store.entries.findIndex((e) => e.type === "starting");
	assert.equal(s.starting?.issue, 12);
	assert.deepEqual(s.hooks, { claim: { issue: 12, agent: "builder", change: at } });
	const e = project.edit("builder", { file: "a.ts", old: "1", new: "2" }, 2);
	assert.ok(e.ok);
	project.publish("builder", "a is 2", 3);
	const end = project.starting("builder", null, undefined, 4, { done: true });
	assert.deepEqual(end.hooks, { unclaim: { issue: 12, agent: "builder", change: at, done: true, version: 1 } });
	assert.equal(project.change(at).issue, 12);
	assert.deepEqual(
		project.changes(0, 50, undefined, 12).changes.map((c) => c.id),
		[at],
	);
	assert.equal(project.changes(0, 50, undefined, 13).changes.length, 0);
	// Replay keeps it.
	assert.equal(Project.load(store.entries, new MemoryStore()).change(at).issue, 12);
});

test("a new note or a plain take-back ends the claim without done; notes without an issue say nothing", () => {
	const { project } = setup();
	assert.equal(project.starting("other", "no issue", undefined, 1).hooks, undefined);
	project.starting("builder", "First", undefined, 1, { issue: 3 });
	const next = project.starting("builder", "Second", undefined, 2, { issue: 4 });
	assert.equal(next.hooks?.unclaim?.issue, 3);
	assert.equal(next.hooks?.unclaim?.done, false);
	assert.equal(next.hooks?.unclaim?.version, undefined, "nothing pushed");
	assert.equal(next.hooks?.claim?.issue, 4);
	const back = project.starting("builder", null, undefined, 3);
	assert.deepEqual([back.hooks?.unclaim?.issue, back.hooks?.unclaim?.done, back.hooks?.claim], [4, false, undefined]);
	assert.equal(project.starting("builder", null, undefined, 4, { done: true }).hooks, undefined, "no note left to end");
});

test("a note made inside a named draft gives the draft's change its issue", () => {
	const { project } = setup();
	project.switchTo("builder", "feat", 1);
	edit(project, "builder", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("builder", "draft version", 3);
	project.starting("builder", "In a draft", undefined, 4, { issue: 5 });
	edit(project, "builder", { file: "a.ts", old: "2", new: "3" }, 5);
	project.publish("builder", "again", 6);
	assert.equal(project.changes(0, 50, undefined, 5).changes.length, 1);
});

test("issue and done are checked", () => {
	const { project } = setup();
	assert.throws(() => project.starting("builder", "x", undefined, 1, { issue: 0 }), /issue is an issue number/);
	assert.throws(() => project.starting("builder", "x", undefined, 1, { issue: "12" }), /issue is an issue number/);
	assert.throws(() => project.starting("builder", null, undefined, 1, { issue: 12 }), /goes with a start note/);
	assert.throws(() => project.starting("builder", "x", undefined, 1, { done: true }), /done goes with a take-back/);
	assert.throws(() => project.starting("builder", null, undefined, 1, { done: "yes" }), /done is true or left out/);
});
