// Everyday commands git has (#27): log, show, diff of the draft, and
// restore (discard one file's unpublished changes).

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";

const START = { "a.txt": "one\ntwo\nthree\n", "b.txt": "x\n" };

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	project.sync("ann");
	project.sync("bob");
	return { project, store };
}

test("log lists versions newest first, and show gives one with its files before and after", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.txt", old: "two\n", new: "TWO\n" }, 1);
	project.publish("ann", "Shout two", 2);
	project.edit("bob", { file: "c.txt", content: "new\n" }, 3);
	project.publish("bob", "Add c", 4);

	const log = project.log();
	assert.equal(log.version, 2);
	assert.deepEqual(
		log.versions.map((v) => [v.version, v.agent, v.message, v.changes, v.files]),
		[
			[2, "bob", "Add c", 1, ["c.txt"]],
			[1, "ann", "Shout two", 1, ["a.txt"]],
			[0, "init", "Start the project", 1, ["a.txt", "b.txt"]],
		],
	);
	assert.equal(project.log({ limit: 1 }).versions.length, 1);

	const shown = project.show(1);
	assert.equal(shown.message, "Shout two");
	assert.deepEqual(shown.diff, [{ path: "a.txt", before: "one\ntwo\nthree\n", after: "one\nTWO\nthree\n" }]);
	assert.deepEqual(project.show(2).diff, [{ path: "c.txt", before: null, after: "new\n" }]);
	assert.deepEqual(
		project.show(0).diff.map((f) => f.before),
		[null, null],
	);
	assert.throws(
		() => project.show(9),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
});

test("log and show work for a named draft", () => {
	const { project } = setup();
	project.switchTo("ann", "exp", 1);
	project.edit("ann", { file: "b.txt", old: "x", new: "y" }, 2);
	project.publish("ann", "Y", 3);
	const log = project.log({ draft: "exp" });
	assert.deepEqual(
		log.versions.map((v) => v.message),
		["Y", "Start draft exp"],
	);
	assert.deepEqual(project.show(1, { draft: "exp" }).diff, [{ path: "b.txt", before: "x\n", after: "y\n" }]);
	assert.throws(
		() => project.log({ draft: "nope" }),
		(e) => e instanceof ProjectError,
	);
});

test("diff shows what the draft changes, file by file", () => {
	const { project } = setup();
	assert.deepEqual(project.diff("ann").files, []);
	project.edit("ann", { file: "a.txt", old: "one\n", new: "uno\n" }, 1);
	project.edit("ann", { file: "b.txt", content: "x\ny\n" }, 2);
	project.edit("ann", { file: "b.txt", content: "x\n" }, 3); // back as it was: no change left
	assert.deepEqual(project.diff("ann"), {
		draft: null,
		base: 0,
		files: [{ path: "a.txt", before: "one\ntwo\nthree\n", after: "uno\ntwo\nthree\n" }],
	});
});

test("restore drops one file’s unpushed changes and keeps the rest", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.txt", old: "one\n", new: "uno\n" }, 1);
	project.edit("ann", { file: "a.txt", old: "three\n", new: "tres\n" }, 2);
	project.edit("ann", { file: "b.txt", old: "x\n", new: "xx\n" }, 3);
	const answer = project.restore("ann", ["a.txt"], 4);
	assert.deepEqual(answer, { files: { "a.txt": "one\ntwo\nthree\n" }, dropped: 2 });
	assert.deepEqual(project.status().agents[0]!.draftChanges, 1);
	assert.deepEqual(
		project.diff("ann").files.map((f) => f.path),
		["b.txt"],
	);
	// A file the draft never touched comes back unchanged and isn't listed.
	assert.deepEqual(project.restore("ann", ["nothing.txt"], 5), { files: {}, dropped: 0 });
	// Restoring everything empties the draft.
	assert.deepEqual(project.restore("ann", null, 6), { files: { "b.txt": "x\n" }, dropped: 1 });
	assert.equal(project.status().agents[0]!.draftChanges, 0);
});

test("restoring one of two recorded files keeps the other, and reloads the same", () => {
	const { project, store } = setup();
	project.record("ann", { "a.txt": "ONE\ntwo\nthree\n", "b.txt": "X\n" }, 1);
	const answer = project.restore("ann", ["a.txt"], 2);
	assert.deepEqual(answer, { files: { "a.txt": "one\ntwo\nthree\n" }, dropped: 1 });
	assert.deepEqual(
		project.diff("ann").files.map((f) => f.path),
		["b.txt"],
	);
	project.publish("ann", "Only b", 3);
	assert.deepEqual(project.files(), { "a.txt": "one\ntwo\nthree\n", "b.txt": "X\n" });
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).status(), project.status());
});

test("a restored change no longer collides", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.txt", old: "two\n", new: "two (ann)\n" }, 1);
	project.edit("bob", { file: "a.txt", old: "two\n", new: "two (bob)\n" }, 1);
	project.publish("bob", "bob", 2);
	assert.equal(project.publish("ann", "ann", 3).ok, false);
	project.restore("ann", ["a.txt"], 4);
	assert.deepEqual(project.publish("ann", "nothing", 5), { ok: true, version: 1, changes: 0 });
});

test("one file's history, a file at a version, and a diff between versions", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.txt", old: "one\n", new: "uno\n" }, 1);
	project.publish("ann", "a once", 2);
	project.edit("bob", { file: "b.txt", old: "x\n", new: "y\n" }, 3);
	project.publish("bob", "b", 4);
	project.sync("ann");
	project.edit("ann", { file: "a.txt", old: "three\n", new: "tres\n" }, 5);
	project.publish("ann", "a twice", 6);

	assert.deepEqual(
		project.log({ path: "a.txt" }).versions.map((v) => v.version),
		[3, 1, 0],
	);
	assert.deepEqual(project.fileAt("a.txt", 1), { path: "a.txt", version: 1, text: "uno\ntwo\nthree\n" });
	assert.deepEqual(project.fileAt("c.txt", 1).text, null);
	assert.deepEqual(project.compare(1, 3).files, [
		{ path: "a.txt", before: "uno\ntwo\nthree\n", after: "uno\ntwo\ntres\n" },
		{ path: "b.txt", before: "x\n", after: "y\n" },
	]);
	assert.deepEqual(
		project.compare(3, 1).files.map((f) => f.after),
		["uno\ntwo\nthree\n", "x\n"],
	);
	assert.equal(project.viewAt(0).text("a.txt"), "one\ntwo\nthree\n");
	assert.throws(
		() => project.fileAt("a.txt", 9),
		(e) => e instanceof ProjectError,
	);
});

test("amend corrects the message of the agent's newest push; the log keeps the original", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	assert.throws(() => project.amend("ann", "x", 1), /nothing to amend/);
	project.edit("ann", { file: "a.txt", old: "a", new: "b" }, 1);
	project.publish("ann", "Fix typo in paser", 2);
	project.sync("bob");
	project.edit("bob", { file: "a.txt", old: "b", new: "c" }, 3);
	project.publish("bob", "C", 4);
	// ann's newest publish is version 1, even with bob's after it.
	assert.deepEqual(project.amend("ann", "Fix typo in parser", 5), {
		version: 1,
		draft: null,
		message: "Fix typo in parser",
		was: "Fix typo in paser",
	});
	const v1 = project.log().versions.find((v) => v.version === 1)!;
	assert.deepEqual([v1.message, v1.originalMessage], ["Fix typo in parser", "Fix typo in paser"]);
	assert.equal(project.files()["a.txt"], "c\n");
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).log(), project.log());
});

test("the log lists a push's net changes: a file made and removed before the push is not one (#37)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "a\n" }, 0);
	project.record("b5", { "src/clock.ts": "clock\n", "src/rng.ts": "rng\n", "notes/builder5.md": "notes\n" }, 1);
	project.record("b5", { "src/clock.ts": null, "src/rng.ts": null }, 2);
	project.publish("b5", "Notes only", 3);
	const v1 = project.log().versions.find((v) => v.version === 1)!;
	assert.deepEqual(v1.files, ["notes/builder5.md"]);
	assert.deepEqual(
		project.show(1).diff.map((f) => f.path),
		["notes/builder5.md"],
	);
	assert.deepEqual(project.log({ path: "src/clock.ts" }).versions, []);
	assert.deepEqual(project.log().versions.find((v) => v.version === 0)!.files, ["a.txt"]);
});
