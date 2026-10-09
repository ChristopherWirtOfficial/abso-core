// Drop (#10): take published versions back out of shared. Shared is a set of
// changes, so a drop is a new version whose set leaves them out, with
// whatever built on them; later work that didn't build on them stays, and
// history keeps everything.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";

const START = { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nbeta\n" };

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	for (const a of ["ann", "bob", "cat"]) project.sync(a);
	return { project, store };
}

/** ann publishes v1 (a.ts), bob publishes v2 (b.ts, unrelated). */
function twoVersions(project: Project): void {
	project.edit("ann", { file: "a.ts", old: "two", new: "TWO" }, 1);
	project.publish("ann", "Shout two", 2);
	project.edit("bob", { file: "b.ts", old: "beta", new: "BETA" }, 3);
	project.publish("bob", "Shout beta", 4);
}

const conflictMessage = (f: () => unknown): string => {
	try {
		f();
	} catch (e) {
		if (e instanceof ProjectError && e.code === "conflict") return e.message;
		throw e;
	}
	return "no conflict";
};

test("dropping a version takes its change out; later unrelated work stays; history keeps both", () => {
	const { project } = setup();
	twoVersions(project);
	const answer = project.drop("cat", [1], "TWO broke the parser", 5);
	assert.deepEqual(answer, { ok: true, version: 3, dropped: [{ version: 1, agent: "ann", message: "Shout two" }] });
	assert.deepEqual(project.files(), { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nBETA\n" });
	const log = project.log().versions;
	assert.deepEqual(log[0]!.drops, [1]);
	assert.deepEqual(log[0]!.files, ["a.ts"]);
	assert.equal(log.find((v) => v.version === 1)!.droppedIn, 3);
	assert.equal(project.fileAt("a.ts", 1).text, "one\nTWO\nthree\n");
	assert.deepEqual(project.show(3).diff, [{ path: "a.ts", before: "one\nTWO\nthree\n", after: "one\ntwo\nthree\n" }]);
	// Everyone hears it, and their next sync takes it out of their folder.
	assert.deepEqual(project.news("bob").news, [
		'cat dropped version 1 from shared (version 3): "TWO broke the parser". Run abso sync to take it out of your folder.',
	]);
	assert.deepEqual(project.sync("ann").files, { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nBETA\n" });
});

test("work that built on a dropped version is listed and refused, unless it goes too", () => {
	const { project } = setup();
	twoVersions(project);
	project.sync("cat");
	project.edit("cat", { file: "a.ts", old: "TWO", new: "TWO!" }, 5);
	project.publish("cat", "Louder", 6);
	const refused = project.drop("bob", [1], "Undo the shouting", 7);
	assert.deepEqual(refused, { ok: false, dependents: [{ version: 3, agent: "cat", message: "Louder" }], blocked: [] });
	assert.equal(project.version, 3);
	const both = project.drop("bob", [1], "Undo the shouting", 7, { withDependents: true });
	assert.equal(both.ok, true);
	assert.deepEqual(both.ok && both.dropped.map((d) => d.version), [1, 3]);
	assert.deepEqual(project.files(), { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nBETA\n" });
});

test("unpublished work that builds on it blocks a drop; drop never touches a draft", () => {
	const { project } = setup();
	twoVersions(project);
	project.sync("cat");
	project.edit("cat", { file: "a.ts", old: "TWO", new: "Two" }, 5);
	const refused = project.drop("bob", [1], "Undo", 6);
	assert.deepEqual(refused, { ok: false, dependents: [], blocked: [{ agent: "cat", files: ["a.ts"] }] });
	// An agent with an unrelated draft doesn't block it.
	project.restore("cat", null, 7);
	project.edit("cat", { file: "b.ts", old: "alpha", new: "ALPHA" }, 7);
	assert.equal(project.drop("bob", [1], "Undo", 8).ok, true);
	assert.equal(project.publish("cat", "Shout alpha", 9).ok, true);
	assert.deepEqual(project.files(), { "a.ts": "one\ntwo\nthree\n", "b.ts": "ALPHA\nBETA\n" });
});

test("an agent that edits dropped lines without syncing is told to restore, not broken", () => {
	const { project } = setup();
	twoVersions(project);
	project.sync("cat"); // cat sees TWO
	assert.equal(project.drop("bob", [1], "Undo", 5).ok, true);
	project.edit("cat", { file: "a.ts", old: "TWO", new: "Two" }, 6); // against its old base
	assert.match(
		conflictMessage(() => project.publish("cat", "Soften", 7)),
		/a\.ts build on lines a drop took out/,
	);
	assert.match(
		conflictMessage(() => project.sync("cat")),
		/abso restore a\.ts/,
	);
	project.restore("cat", ["a.ts"], 8);
	assert.deepEqual(project.sync("cat").files, { "a.ts": "one\ntwo\nthree\n" });
});

test("dropping a deletion brings the lines back; dropping a move puts the lines back where they were", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.ts", old: "two\n", new: "" }, 1);
	project.publish("ann", "No two", 2);
	project.record("bob", { "b.ts": null, "c.ts": START["b.ts"] }, 3);
	project.publish("bob", "Rename b to c", 4); // bob's base is old; publish still lands
	assert.deepEqual(project.files(), { "a.ts": "one\nthree\n", "c.ts": "alpha\nbeta\n" });
	assert.equal(project.drop("cat", [1], "Two is needed", 5).ok, true);
	assert.equal(project.drop("cat", [2], "Keep the old name", 6).ok, true);
	assert.deepEqual(project.files(), START);
});

test("a dropped land is never landed again by its draft", () => {
	const { project } = setup();
	project.switchTo("ann", "feature", 1);
	project.edit("ann", { file: "a.ts", old: "one", new: "ONE" }, 1);
	project.publish("ann", "One loud", 2);
	assert.equal(project.land("ann", "Feature", 3).ok, true);
	assert.equal(project.files()["a.ts"], "ONE\ntwo\nthree\n");
	assert.equal(project.drop("bob", [1], "Not yet", 4).ok, true);
	assert.equal(project.files()["a.ts"], "one\ntwo\nthree\n");
	const again = project.land("ann", "Feature again", 5);
	assert.deepEqual(again, { ok: true, version: 2, changes: 0 });
	assert.equal(project.files()["a.ts"], "one\ntwo\nthree\n");
});

test("bad drops are plain errors; a log with drops loads back the same", () => {
	const { project, store } = setup();
	twoVersions(project);
	assert.throws(() => project.drop("cat", [0], "x", 5), /version 0 is the start/);
	assert.throws(() => project.drop("cat", [9], "x", 5), /no version 9/);
	assert.throws(() => project.drop("cat", [1], "", 5), /message/);
	project.drop("cat", [1], "x", 5);
	assert.throws(() => project.drop("cat", [1], "x", 6), /already dropped in version 3/);
	assert.throws(() => project.drop("cat", [3], "x", 6), /added nothing/);
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.files(), project.files());
	assert.deepEqual(again.log(), project.log());
});
