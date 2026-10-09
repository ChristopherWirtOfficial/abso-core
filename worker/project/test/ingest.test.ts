// Taking in a plain-git push (demo moment 5): a person cloned shared from
// Artifacts, committed with ordinary git, and pushed. The commits join the
// graph as diffs; they land in shared unless they collide, and then they wait
// in their own named draft.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";

const START = { "a.txt": "one\ntwo\nthree\n", "b.txt": "x\n" };

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	project.sync("agent");
	return { project, store };
}

test("commits that collide with nothing land in shared, one diff each", () => {
	const { project } = setup();
	const answer = project.ingest(
		{
			author: "Robin",
			base: 0,
			commits: [
				{ sha: "aaaaaaaa1111", message: "Shout one", files: { "a.txt": "ONE\ntwo\nthree\n", "b.txt": "x\n" } },
				{ sha: "bbbbbbbb2222", message: "Add c, drop b", files: { "a.txt": "ONE\ntwo\nthree\n", "c.txt": "new\n" } },
			],
		},
		1,
	);
	assert.deepEqual(answer, { landed: true, version: 1, draft: "git-aaaaaaaa1111", changes: 5 });
	assert.deepEqual(project.files(), { "a.txt": "ONE\ntwo\nthree\n", "c.txt": "new\n" });
	assert.match(project.published(1)!.message, /^Add c, drop b\n\nGit-Commit: bbbbbbbb2222\nAuthor: Robin$/);
	// Agents get it the usual way.
	assert.deepEqual(project.sync("agent").files, { "a.txt": "ONE\ntwo\nthree\n", "b.txt": null, "c.txt": "new\n" });
});

test("a push built on an older version still lands when it touches other lines", () => {
	const { project } = setup();
	project.edit("agent", { file: "a.txt", old: "three\n", new: "THREE\n" }, 1);
	project.publish("agent", "Agent shouts three", 2);
	const answer = project.ingest(
		{
			author: "p",
			base: 0,
			commits: [{ sha: "cccccccc", message: "One", files: { "a.txt": "uno\ntwo\nthree\n", "b.txt": "x\n" } }],
		},
		3,
	);
	assert.equal(answer.landed, true);
	assert.equal(project.files()["a.txt"], "uno\ntwo\nTHREE\n");
});

test("a push that collides waits in its named draft, and can be settled and landed there", () => {
	const { project } = setup();
	project.edit("agent", { file: "a.txt", old: "two\n", new: "two (agent)\n" }, 1);
	project.publish("agent", "Agent edits two", 2);
	const answer = project.ingest(
		{
			author: "p",
			base: 0,
			commits: [
				{
					sha: "dddddddd",
					message: "Person edits two",
					files: { "a.txt": "one\ntwo (person)\nthree\n", "b.txt": "x\n" },
				},
			],
		},
		3,
	);
	assert.equal(answer.landed, false);
	assert.equal(!answer.landed && answer.draft, "git-dddddddd");
	assert.equal(!answer.landed && answer.collisions[0]!.theirs.agent, "agent");
	assert.equal(project.version, 1, "shared kept the agent version");
	assert.deepEqual(
		project.status().drafts.map((d) => [d.name, d.changes]),
		[["git-dddddddd", 2]],
	);

	// Anyone can settle it: switch to the draft, move it onto shared, edit, land.
	project.switchTo("fixer", "git-dddddddd", 4);
	project.syncDraft("fixer", 5);
	const synced = project.sync("fixer");
	assert.equal(synced.collisions.length, 1);
	project.record("fixer", { "a.txt": "one\ntwo (agent and person)\nthree\n" }, 6);
	project.publish("fixer", "Settle two", 7);
	assert.equal(project.land("fixer", "Land the person push", 8).ok, true);
	assert.equal(project.files()["a.txt"], "one\ntwo (agent and person)\nthree\n");
});

test("the same push is taken in once, and bad input is refused", () => {
	const { project, store } = setup();
	const push = {
		author: "p",
		base: 0,
		commits: [{ sha: "eeeeeeee", message: "m", files: { "a.txt": "one\n", "b.txt": "x\n" } }],
	};
	project.ingest(push, 1);
	assert.throws(
		() => project.ingest(push, 2),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
	assert.throws(
		() => project.ingest({ ...push, base: 99 }, 2),
		(e) => e instanceof ProjectError,
	);
	assert.throws(
		() => project.ingest({ ...push, commits: [] }, 2),
		(e) => e instanceof ProjectError,
	);
	assert.throws(
		() => project.ingest({ ...push, commits: [{ sha: "not hex", message: "m", files: {} }] }, 2),
		(e) => e instanceof ProjectError,
	);
	// A refused ingest wrote nothing.
	const before = store.entries.length;
	assert.throws(() =>
		project.ingest(
			{ author: "p", base: 0, commits: [{ sha: "ffffffff", message: "m", files: { ".avcs/x": "y" } }] },
			3,
		),
	);
	assert.equal(store.entries.length, before);
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).status(), project.status());
});
