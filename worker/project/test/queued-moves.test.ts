// A publish while the agent's earlier publish still waits in the queue (#39)
// must leave the queued one's changes alone (abso issue 135, item 4). Moves
// (#28) are expressed by dropping the draft's changes to the files involved
// and making them again; when that took a queued item's atoms too, the queue
// later landed the item with a tie depending on discarded atoms, and the
// project's log no longer loaded (typescript-rs, entries 6017 and 6504).

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

test("a move in a later publish leaves the agent's queued publish whole, and both land", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.checkerReady = true;
	project.init(
		{
			"avcs.json": `${JSON.stringify({ queue: true })}\n`,
			"a.ts": "export const a = 1;\nexport function kept() {\n\treturn 'x';\n}\n",
			"c.ts": "export const c = 1;\n",
		},
		0,
	);
	project.sync("one");
	// The first publish changes a.ts and waits in the queue.
	edit(project, "one", { file: "a.ts", old: "const a = 1", new: "const a = 2" }, 1);
	const first = project.publish("one", "a is 2", 2);
	assert.ok(first.ok && "queued" in first, JSON.stringify(first));
	// The second moves kept() from a.ts to c.ts, so a.ts is a file the move involves.
	edit(project, "one", { file: "a.ts", old: "export function kept() {\n\treturn 'x';\n}\n", new: "" }, 3);
	edit(
		project,
		"one",
		{
			file: "c.ts",
			old: "export const c = 1;\n",
			new: "export const c = 1;\nexport function kept() {\n\treturn 'x';\n}\n",
		},
		4,
	);
	const second = project.publish("one", "move kept to c", 5);
	assert.ok(second.ok && "queued" in second, JSON.stringify(second));

	const ids = project.queue().items.map((q) => q.id);
	assert.equal(ids.length, 2);
	project.queueChecking(2);
	assert.deepEqual(
		project.queueLand(2, 6).versions.map((v) => v.version),
		[1, 2],
	);
	assert.equal(project.files()["a.ts"], "export const a = 2;\n");
	assert.equal(project.files()["c.ts"], "export const c = 1;\nexport function kept() {\n\treturn 'x';\n}\n");
	// The log replays: no publish depends on a discarded atom.
	const again = Project.load(store.entries, new MemoryStore());
	assert.equal(again.files()["a.ts"], "export const a = 2;\n");
	assert.equal(again.version, 2);
});

test("restore while a publish waits in the queue undoes only the later edits, and the queued one lands", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.checkerReady = true;
	project.init(
		{ "avcs.json": `${JSON.stringify({ queue: true })}\n`, "a.ts": "export const a = 1;\nexport const b = 1;\n" },
		0,
	);
	project.sync("one");
	edit(project, "one", { file: "a.ts", old: "const a = 1", new: "const a = 2" }, 1);
	const first = project.publish("one", "a is 2", 2);
	assert.ok(first.ok && "queued" in first, JSON.stringify(first));
	edit(project, "one", { file: "a.ts", old: "const b = 1", new: "const b = 2" }, 3);
	const r = project.restore("one", ["a.ts"], 4);
	assert.equal(r.files["a.ts"], "export const a = 2;\nexport const b = 1;\n", "the queued change stays");
	project.queueChecking(1);
	assert.deepEqual(
		project.queueLand(1, 5).versions.map((v) => v.version),
		[1],
	);
	assert.equal(project.files()["a.ts"], "export const a = 2;\nexport const b = 1;\n");
	assert.equal(
		Project.load(store.entries, new MemoryStore()).files()["a.ts"],
		"export const a = 2;\nexport const b = 1;\n",
	);
});
