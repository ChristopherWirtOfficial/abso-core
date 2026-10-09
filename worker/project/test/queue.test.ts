// The merge queue's engine half (#39): with `"queue": true` in shared's
// avcs.json, a publish to shared waits in the queue instead of landing. It is
// refused at once when it collides with shared or anything queued ahead of
// it, so the queue only holds publishes that merge cleanly. A checker takes
// the first few as a candidate, and lands them or pulls one; what it builds
// on comes out with it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

function setup(queue = true) {
	const store = new MemoryStore();
	const project = new Project(store);
	project.checkerReady = true;
	project.init(
		{
			"avcs.json": JSON.stringify({ queue }) + "\n",
			"a.ts": "export const a = 1;\n",
			"b.ts": "export const b = 1;\n",
			"c.ts": "export const c = 1;\n",
		},
		0,
	);
	for (const a of ["one", "two", "three"]) project.sync(a);
	return { project, store };
}

/** A publish that must be queued: its id. */
function queued(project: Project, agent: string, message: string, time: number): number {
	const a = project.publish(agent, message, time);
	assert.ok(a.ok && "queued" in a, JSON.stringify(a));
	return a.queued;
}

test("without the queue a publish lands as before", () => {
	const { project } = setup(false);
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	const a = project.publish("one", "a is 2", 2);
	assert.ok(a.ok && "version" in a && a.version === 1);
	assert.deepEqual(project.queue().items, []);
});

test("a queued publish waits, shows in status and the candidate, and lands as its own version with the same tree", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	const a = project.publish("one", "a is 2", 2);
	assert.deepEqual(a, { ok: true, queued: 1, position: 1, ahead: 0, changes: 1 });
	assert.equal(project.version, 0, "shared has not moved");
	assert.equal(project.files()["a.ts"], "export const a = 1;\n");
	assert.deepEqual(project.status().agents.find((x) => x.agent === "one")?.queued, [1]);
	assert.deepEqual(
		project.queue().items.map((q) => [q.id, q.agent, q.message, q.changes, q.checking]),
		[[1, "one", "a is 2", 1, false]],
	);

	const candidate = project.queueCandidate(1);
	assert.deepEqual(candidate.ids, [1]);
	assert.equal(candidate.files["a.ts"], "export const a = 2;\n");
	assert.notEqual(candidate.tree, project.treeAt(0));

	assert.deepEqual(project.queueChecking(1), [1]);
	assert.equal(project.queue().items[0]!.checking, true);
	assert.deepEqual(project.queueLand(1, 3).versions, [{ id: 1, version: 1 }]);
	assert.equal(project.version, 1);
	assert.equal(project.treeAt(1), candidate.tree);
	assert.deepEqual(project.queue().items, []);
	assert.equal(project.status().agents.find((x) => x.agent === "one")?.queued, undefined);
	assert.ok(project.news("one").news.some((n) => n.includes('Your queued publish "a is 2" landed as version 1')));
});

test("a publish that changes lines queued ahead of it is refused at once, naming the queued one", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	edit(project, "two", { file: "a.ts", old: "1", new: "3" }, 3);
	const a = project.publish("two", "a is 3", 4);
	assert.equal(a.ok, false);
	assert.ok(!a.ok);
	assert.equal(a.collisions[0]!.kind, "lines");
	assert.deepEqual([a.collisions[0]!.theirs.agent, a.collisions[0]!.theirs.queued], ["one", 1]);
	assert.equal(project.queue().items.length, 1);
});

test("a name defined both in a queued publish and in a new one is refused", () => {
	const { project } = setup();
	edit(
		project,
		"one",
		{ file: "a.ts", old: "export const a = 1;\n", new: "export const a = 1;\nexport function parse() {}\n" },
		1,
	);
	queued(project, "one", "parse", 2);
	edit(
		project,
		"two",
		{ file: "a.ts", old: "export const a = 1;\n", new: "export function parse() {}\nexport const a = 1;\n" },
		3,
	);
	const a = project.publish("two", "parse too", 4);
	assert.ok(!a.ok);
	assert.ok(
		a.collisions.some((c) => c.name === "parse" && c.theirs.queued === 1),
		JSON.stringify(a.collisions),
	);
});

test("publishes to different files queue behind each other and land in order", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	edit(project, "two", { file: "b.ts", old: "1", new: "2" }, 3);
	const b = project.publish("two", "b is 2", 4);
	assert.deepEqual(b, { ok: true, queued: 2, position: 2, ahead: 1, changes: 1 });
	const both = project.queueCandidate(2);
	assert.deepEqual([both.files["a.ts"], both.files["b.ts"]], ["export const a = 2;\n", "export const b = 2;\n"]);
	assert.deepEqual(project.queueLand(2, 5).versions, [
		{ id: 1, version: 1 },
		{ id: 2, version: 2 },
	]);
	assert.equal(project.treeAt(2), both.tree);
	assert.deepEqual(
		project
			.log()
			.versions.map((v) => v.message)
			.slice(0, 2),
		["b is 2", "a is 2"],
	);
});

test("a failed publish is pulled with the check's output; its changes stay in the draft and can be queued again", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	assert.deepEqual(project.queuePull(1, "failed", 3, "line 1\nnot ok 1 - a is 1\n").pulled, [1]);
	assert.deepEqual(project.queue().items, []);
	const news = project.news("one").news.join("\n");
	assert.ok(news.includes("was pulled: the project's check failed on it"), news);
	assert.ok(news.includes("not ok 1 - a is 1"));
	assert.equal(project.diff("one").files.length, 1, "the change is still in the draft");
	assert.equal(queued(project, "one", "a is 2, again", 4), 2);
});

test("a queued publish built on a pulled one comes out with it", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	edit(project, "one", { file: "a.ts", old: "2", new: "22" }, 3);
	assert.deepEqual(project.publish("one", "a is 22", 4), { ok: true, queued: 2, position: 2, ahead: 1, changes: 1 });
	edit(project, "two", { file: "b.ts", old: "1", new: "2" }, 5);
	queued(project, "two", "b is 2", 6);
	assert.deepEqual(project.queuePull(1, "failed", 7).pulled, [1, 2]);
	assert.deepEqual(
		project.queue().items.map((q) => q.id),
		[3],
	);
	assert.ok(project.news("one").news.some((n) => n.includes("it builds on queued publish 1, which was pulled")));
});

test("an agent can withdraw its queued publishes while they wait, not while they are being checked", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	project.queueChecking(1);
	assert.throws(() => project.unqueue("one", 3), /being checked/);
	project.queueChecking(0);
	assert.deepEqual(project.unqueue("one", 4).pulled, [1]);
	assert.throws(() => project.unqueue("one", 5), /nothing queued/);
});

test("landing leaves edits made after queueing in the agent's draft", () => {
	const { project } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	edit(project, "one", { file: "b.ts", old: "1", new: "5" }, 3);
	project.queueLand(1, 4);
	assert.equal(project.files()["a.ts"], "export const a = 2;\n");
	assert.deepEqual(
		project.diff("one").files.map((f) => f.path),
		["b.ts"],
	);
});

test("the queue is rebuilt from the log", () => {
	const { project, store } = setup();
	edit(project, "one", { file: "a.ts", old: "1", new: "2" }, 1);
	queued(project, "one", "a is 2", 2);
	edit(project, "two", { file: "b.ts", old: "1", new: "2" }, 3);
	queued(project, "two", "b is 2", 4);
	project.queuePull(1, "withdrawn", 5);
	const again = Project.load(store.entries, new MemoryStore());
	again.checkerReady = true;
	assert.deepEqual(
		again.queue().items.map((q) => [q.id, q.agent]),
		[[2, "two"]],
	);
	assert.equal(again.queueCandidate(1).tree, project.queueCandidate(1).tree);
	edit(again, "three", { file: "c.ts", old: "1", new: "2" }, 6);
	assert.equal(queued(again, "three", "c is 2", 7), 3, "ids keep counting after a reload");
});
