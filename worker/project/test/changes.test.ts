// Changes (#44, the ruling on questions 1-3): a change is one start
// note's work, a named draft's, or a lone publish. Start notes last through
// publishes until the next start, a take-back (publish --done), or 2 hours
// idle. The change page reads one change; "since you last looked" lists the
// changes with anything new after a log position.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, type Entry, MemoryStore, Project } from "../project.ts";

const HOUR = 60 * 60 * 1000;

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

function setup() {
	const store = new MemoryStore();
	let now = 0;
	const project = new Project(store, { now: () => now });
	project.init(
		{ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n", "c.ts": "export const c = 1;\n" },
		0,
	);
	for (const a of ["ann", "bob"]) project.sync(a);
	return { project, store, at: (t: number) => (now = t) };
}

const publishOf = (store: MemoryStore, version: number) =>
	store.entries.find(
		(e): e is Extract<Entry, { type: "publish" }> => e.type === "publish" && e.version === version && !e.space,
	)!;

test("a start note's publishes are one change, with its versions, files and title", () => {
	const { project, store, at } = setup();
	at(1);
	project.starting("ann", "Bigger numbers", ["a.ts", "b.ts"], 1);
	const noteAt = store.entries.findIndex((e) => e.type === "starting");
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("ann", "a is 2", 3);
	edit(project, "bob", { file: "c.ts", old: "1", new: "5" }, 4);
	project.publish("bob", "c is 5", 5);
	project.sync("ann");
	edit(project, "ann", { file: "b.ts", old: "1", new: "2" }, 6);
	project.publish("ann", "b is 2", 7);
	at(8);
	assert.equal(publishOf(store, 1).change, noteAt);
	assert.equal(publishOf(store, 3).change, noteAt);
	const c = project.change(noteAt);
	assert.deepEqual(
		[c.kind, c.agent, c.title, c.open, c.note],
		["note", "ann", "Bigger numbers", true, { text: "Bigger numbers", files: ["a.ts", "b.ts"] }],
	);
	assert.deepEqual(
		c.versions.map((v) => [v.version, v.message, v.files]),
		[
			[1, "a is 2", ["a.ts"]],
			[3, "b is 2", ["b.ts"]],
		],
	);
	assert.deepEqual(c.files, ["a.ts", "b.ts"]);
	// bob's publish, with no start note, is a change of its own, named by its publish's log position.
	const bobs = publishOf(store, 2).change!;
	assert.deepEqual(
		[project.change(bobs).kind, project.change(bobs).title, project.change(bobs).open],
		["publish", "c is 5", false],
	);
	assert.throws(() => project.change(9999), /there is no change 9999/);
});

test("a start note ends at the next start, a take-back, or 2 hours idle, and so does its change", () => {
	const { project, store, at } = setup();
	project.starting("ann", "One", undefined, 1);
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("ann", "first", 3);
	const one = publishOf(store, 1).change!;
	project.starting("ann", "Two", undefined, 4);
	edit(project, "ann", { file: "a.ts", old: "2", new: "3" }, 5);
	project.publish("ann", "second", 6);
	const two = publishOf(store, 2).change!;
	assert.notEqual(one, two);
	at(6);
	assert.equal(project.change(one).open, false);
	assert.equal(project.change(two).open, true);
	// Taken back (what publish --done sends).
	project.starting("ann", null, undefined, 7);
	assert.equal(project.change(two).open, false);
	// Idle: a note, then nothing for over 2 hours, then a publish is a change of its own.
	project.starting("ann", "Three", undefined, 10);
	at(10 + 2 * HOUR + 1);
	assert.equal(project.startingNotes().length, 0, "the note has ended");
	edit(project, "ann", { file: "a.ts", old: "3", new: "4" }, 10 + 2 * HOUR + 1);
	project.publish("ann", "after a break", 10 + 2 * HOUR + 2);
	const after = publishOf(store, 3);
	assert.equal(project.change(after.change!).kind, "publish");
});

test("a named draft's work is one change, its land included", () => {
	const { project, store } = setup();
	project.switchTo("ann", "feature", 1);
	const startedAt = store.entries.findIndex((e) => e.type === "space");
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("ann", "in the draft", 3);
	project.land("ann", "Land feature", 4);
	const c = project.change(startedAt);
	assert.deepEqual([c.kind, c.draft, c.title], ["draft", "feature", "Draft feature"]);
	assert.deepEqual(
		c.versions.map((v) => [v.draft, v.message]),
		[
			["feature", "in the draft"],
			[null, "Land feature"],
		],
	);
});

test("since you last looked: the changes with anything new after a log position, newest first", () => {
	const { project, store } = setup();
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 1);
	project.publish("ann", "a is 2", 2);
	const mark = store.entries.length;
	edit(project, "bob", { file: "b.ts", old: "1", new: "2" }, 3);
	project.publish("bob", "b is 2", 4);
	// A refusal lands on the refused agent's change only when it has one: a start note here.
	project.starting("ann", "Clash", undefined, 5);
	edit(project, "ann", { file: "b.ts", old: "export const b = 1;", new: "export const b = 9;" }, 6);
	assert.equal(project.publish("ann", "b is 9", 7).ok, false);
	const since = project.changes(mark);
	assert.deepEqual(
		since.changes.map((c) => [c.agent, c.title]),
		[
			["ann", "Clash"],
			["bob", "b is 2"],
		],
	);
	assert.deepEqual(
		since.changes[0]!.refusals.map((r) => [r.kinds, r.files]),
		[[["lines"], ["b.ts"]]],
	);
	assert.equal(since.next, store.entries.length);
	assert.equal(project.changes(0).changes.length, 3);
});

test("changes come back the same from the log, and old publishes without a change still group and end the note", () => {
	const { project, store } = setup();
	project.starting("ann", "Note", undefined, 1);
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("ann", "one", 3);
	const again = Project.load(store.entries, new MemoryStore(), { now: () => 3 });
	assert.deepEqual(again.changes(0), project.changes(0));
	// The same log as written before changes: no `change` on the publish.
	const old = store.entries.map((e) => (e.type === "publish" ? (({ change: _, ...rest }) => rest)(e) : e)) as Entry[];
	const replayed = Project.load(old, new MemoryStore(), { now: () => 3 });
	assert.equal(replayed.startingNotes().length, 0, "an old publish ended the note");
	const noteAt = store.entries.findIndex((e) => e.type === "starting");
	assert.deepEqual(
		replayed.change(noteAt).versions.map((v) => v.message),
		["one"],
	);
});

test("log and show name each version's change", () => {
	const { project, store } = setup();
	project.starting("ann", "Note", undefined, 1);
	const noteAt = store.entries.findIndex((e) => e.type === "starting");
	edit(project, "ann", { file: "a.ts", old: "1", new: "2" }, 2);
	project.publish("ann", "one", 3);
	assert.equal(project.log().versions[0]!.change, noteAt);
	assert.equal(project.show(1).change, noteAt);
	assert.equal(project.log().versions.at(-1)!.change, undefined, "init belongs to no change");
});

test("changes pages back with before, and says where the next older page starts", () => {
	const { project } = setup();
	for (let i = 2; i <= 6; i++) {
		edit(project, "ann", { file: "a.ts", old: `a = ${i - 1}`, new: `a = ${i}` }, i);
		project.publish("ann", `a is ${i}`, i);
	}
	const first = project.changes(0, 2);
	assert.deepEqual(
		first.changes.map((c) => c.title),
		["a is 6", "a is 5"],
	);
	const second = project.changes(0, 2, first.older);
	assert.deepEqual(
		second.changes.map((c) => c.title),
		["a is 4", "a is 3"],
	);
	const last = project.changes(0, 2, second.older);
	assert.deepEqual([last.changes.map((c) => c.title), last.older], [["a is 2"], undefined]);
});
