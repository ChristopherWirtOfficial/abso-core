// Fixes from a code review (2026-10-07, batches 1 and 2), each
// with the review's repro: notes follow moved and parked lines, land and drop
// tell an objector, a queued publish keeps its start note, announcement and
// note numbers survive replay, and the queue never lands a tree it didn't
// check.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";
import { queueRound } from "../queue-driver.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

const AUTH = "// auth\nexport function login(user) {\n  return check(user);\n}\n";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store, { now: () => 100 });
	project.init({ "auth.ts": "// auth\n", "notes.md": "# notes\n" }, 0);
	for (const a of ["builder", "security", "writer"]) project.sync(a);
	edit(project, "builder", { file: "auth.ts", content: AUTH }, 2);
	project.publish("builder", "Add login", 3);
	for (const a of ["security", "writer"]) project.sync(a);
	return { project, store };
}

test("an objection follows its lines through a move, and nobody hears they were fixed", () => {
	const { project, store } = setup();
	project.note("security", { file: "auth.ts", from: 3, to: 3, text: "verify the state", kind: "objection" }, 4);
	project.news("security");
	project.sync("builder");
	project.move("builder", "auth.ts", "login.ts", 5);
	project.publish("builder", "auth is login", 6);
	const n = project.notes().notes[0]!;
	assert.deepEqual([n.file, n.lines, n.state], ["login.ts", [3, 3], "open"]);
	assert.equal(project.notes({ file: "login.ts" }).notes.length, 1, "found under the new name");
	assert.equal(project.notes({ file: "auth.ts" }).notes.length, 1, "and the name it was written on");
	assert.equal(project.news("security").news.length, 0, 'no "addressed" news');
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).notes(), project.notes());
});

test("a note on lines published into a named draft stays open while their author works in shared", () => {
	const { project } = setup();
	project.switchTo("builder", "feat", 10);
	edit(
		project,
		"builder",
		{ file: "auth.ts", old: "  return check(user);\n", new: "  return check(user, state);\n" },
		11,
	);
	project.publish("builder", "state", 12);
	project.note(
		"security",
		{ of: "builder", file: "auth.ts", from: 3, to: 3, text: "is state checked?", kind: "objection" },
		13,
	);
	project.switchTo("builder", null, 14);
	assert.deepEqual(
		project.notes().notes.map((n) => [n.lines, n.state]),
		[[[3, 3], "open"]],
	);
	// An unrelated publish to shared doesn't tell security it was fixed.
	project.news("security");
	edit(project, "writer", { file: "notes.md", old: "# notes", new: "# Notes" }, 15);
	project.publish("writer", "title", 16);
	assert.equal(project.news("security").news.length, 0);
});

test("a land, a pluck and a drop that fix an objection tell its writer", () => {
	const { project } = setup();
	project.note("security", { file: "auth.ts", from: 3, to: 3, text: "verify the state", kind: "objection" }, 4);
	project.news("security");
	project.sync("builder");
	project.switchTo("builder", "fix", 5);
	edit(
		project,
		"builder",
		{ file: "auth.ts", old: "  return check(user);\n", new: "  return check(user, state);\n" },
		6,
	);
	project.publish("builder", "check the state", 7);
	project.land("builder", "the fix", 8);
	assert.ok(
		project.news("security").news.some((x) => x.startsWith("builder's version 2 changed every line your objection 1")),
		"land",
	);

	// A drop that takes the objected lines out.
	const q = setup().project;
	edit(q, "writer", { file: "auth.ts", old: "// auth\n", new: "// auth\n// TODO\n" }, 4);
	q.publish("writer", "todo", 5); // v2
	q.sync("security");
	q.note("security", { file: "auth.ts", from: 2, to: 2, text: "no TODOs in shared", kind: "objection" }, 6);
	q.news("security");
	q.drop("builder", [2], "no todo", 7);
	assert.ok(
		q.news("security").news.some((x) => x.includes("your objection 1")),
		"drop",
	);
});

test("a queued publish keeps the start note it was queued under", () => {
	const store = new MemoryStore();
	const project = new Project(store, { now: () => 10 });
	project.checkerReady = true;
	project.init({ "avcs.json": '{"queue": true}\n', "a.ts": "export const a = 1;\n" }, 0);
	project.sync("builder");
	project.starting("builder", "Bigger a", ["a.ts"], 1);
	const noteAt = store.entries.findIndex((e) => e.type === "starting");
	edit(project, "builder", { file: "a.ts", old: "1", new: "2" }, 2);
	const p = project.publish("builder", "a is 2", 3);
	assert.ok(p.ok && "queued" in p);
	project.starting("builder", "Next thing", ["b.ts"], 4);
	project.queueLand(1, 5);
	const c = project.change(noteAt);
	assert.deepEqual([c.kind, c.note?.text], ["note", "Bigger a"]);
	const again = Project.load(store.entries, new MemoryStore(), { now: () => 10 });
	assert.deepEqual([again.change(noteAt).kind, again.change(noteAt).note?.text], ["note", "Bigger a"]);
});

test("announcement and note numbers aren't reused after a reload", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.ts": "a\n" }, 0);
	project.sync("builder");
	// To nobody: no news is written, so the number isn't taken.
	const first = project.announcePerson({ id: "cf-1", name: "C" }, "hello", [], 1);
	const second = project.announcePerson({ id: "cf-1", name: "C" }, "hello again", undefined, 2);
	const again = Project.load(store.entries, new MemoryStore());
	assert.equal(again.announcePerson({ id: "cf-1", name: "C" }, "third", undefined, 3).id, second.id + 1);
	assert.equal(first.id, second.id, "the unwritten one gave its number back");
	project.note("builder", { file: "a.ts", from: 1, text: "one" }, 4);
	assert.equal(
		Project.load(store.entries, new MemoryStore()).note("builder", { file: "a.ts", from: 1, text: "two" }, 5).id,
		2,
	);
});

test("the queue lands nothing when shared moved while it checked, and lands on the next round", async () => {
	const project = new Project(new MemoryStore());
	project.checkerReady = true;
	project.init(
		{ "avcs.json": '{"queue": true}\n', "a.ts": "export const a = 0;\n", "b.ts": "export const b = 0;\n" },
		0,
	);
	for (const x of ["a", "b", "c"]) project.sync(x);
	edit(project, "a", { file: "a.ts", old: "= 0", new: "= 1" }, 1);
	project.publish("a", "a is 1", 1);
	const pass = {
		async check() {
			return { kind: "pass" as const };
		},
	};
	assert.equal((await queueRound(project, pass)).kind, "landed"); // v1
	edit(project, "b", { file: "b.ts", old: "= 0", new: "= 2" }, 2);
	project.publish("b", "b is 2", 2);
	const checked: string[] = [];
	const dropping = {
		async check(c: { files: Record<string, string> }) {
			checked.push(c.files["a.ts"]!);
			if (checked.length === 1) project.drop("c", [1], "not a", 3);
			return { kind: "pass" as const };
		},
	};
	assert.deepEqual(await queueRound(project, dropping), { kind: "moved", checks: 1 });
	assert.equal(project.queue().items.length, 1, "still queued");
	const r = await queueRound(project, dropping);
	assert.equal(r.kind, "landed");
	assert.deepEqual(checked, ["export const a = 1;\n", "export const a = 0;\n"]);
	assert.equal(project.files()["a.ts"], checked[1], "what landed is what was checked");
});

test("a broken avcs.json never reaches shared, so files kept whole and the queue stay on (batch 4)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "avcs.json": '{"whole": ["rec/**"]}\n', "rec/a.json": "{}\n" }, 0);
	project.sync("alice");
	project.record("alice", { "avcs.json": '{"whole": ["rec/**"],}\n' }, 1);
	assert.throws(() => project.publish("alice", "trailing comma", 2), /avcs\.json isn't valid JSON/);
	project.record("alice", { "avcs.json": '{"whole": "rec/**"}\n' }, 3);
	assert.throws(() => project.publish("alice", "not a list", 4), /has "whole" that isn't a list of path globs/);
	project.record("alice", { "avcs.json": '{"whole": ["rec/**"], "queue": "yes"}\n' }, 5);
	assert.throws(() => project.publish("alice", "queue as text", 6), /has "queue" that isn't true or false/);
	assert.equal(project.files()["avcs.json"], '{"whole": ["rec/**"]}\n', "shared keeps the good one");
	assert.throws(
		() => new Project(new MemoryStore()).init({ "avcs.json": "[1]\n" }, 0),
		/init: avcs\.json must be a JSON object/,
	);
	// A good change goes.
	project.record("alice", { "avcs.json": '{"whole": ["rec/**", "gen/**"]}\n' }, 7);
	assert.equal(project.publish("alice", "more whole", 8).ok, true);
});
