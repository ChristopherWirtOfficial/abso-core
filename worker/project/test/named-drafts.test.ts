// Named drafts (#10): a small shared that builds on a version of shared. Its
// agents publish into it under the same rules, and it lands in shared as one
// unit. Shared's other agents don't see any of it until then.

import assert from "node:assert/strict";
import { test } from "node:test";
import { unresolvedConflicts } from "../../../src/engine/index.ts";
import { MemoryStore, Project, ProjectError } from "../project.ts";

const START = {
	"core.ts": "export function step(x: number) {\n  return x + 1;\n}\n\nexport const version = 1;\n",
	"notes.md": "one\ntwo\nthree\n",
};

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	for (const a of ["ann", "bob", "cat"]) project.sync(a);
	return { project, store };
}

test("two agents work in a named draft; shared sees nothing until it lands", () => {
	const { project } = setup();
	assert.deepEqual(project.switchTo("ann", "rewrite", 1), { version: 0, files: {}, collisions: [], draft: "rewrite" });
	project.switchTo("bob", "rewrite", 1);

	project.edit("ann", { file: "core.ts", old: "  return x + 1;", new: "  return x * 2;" }, 2);
	assert.deepEqual(project.publish("ann", "Double instead", 3), { ok: true, version: 1, changes: 1 });
	assert.equal(project.version, 0, "shared did not move");

	// bob gets ann's change by syncing inside the draft; cat in shared gets nothing.
	assert.deepEqual(project.sync("bob").files, {
		"core.ts": "export function step(x: number) {\n  return x * 2;\n}\n\nexport const version = 1;\n",
	});
	assert.deepEqual(project.sync("cat").files, {});

	project.edit("bob", { file: "notes.md", old: "two\n", new: "two (rewrite)\n" }, 4);
	project.publish("bob", "Note it", 5);
	const status = project.status();
	assert.deepEqual(status.drafts, [{ name: "rewrite", version: 2, sharedBase: 0, changes: 4, agents: ["ann", "bob"] }]);

	// Landing puts all of it in shared at once.
	assert.deepEqual(project.land("ann", "Land the rewrite", 6), { ok: true, version: 1, changes: 4 });
	const cat = project.sync("cat");
	assert.deepEqual(cat.files, {
		"core.ts": "export function step(x: number) {\n  return x * 2;\n}\n\nexport const version = 1;\n",
		"notes.md": "one\ntwo (rewrite)\nthree\n",
	});
	assert.equal(project.land("ann", "Again", 7).ok && project.status().version, 1, "nothing left to land");
});

test("landing is refused when shared changed the same lines, and settled inside the draft", () => {
	const { project } = setup();
	project.switchTo("ann", "exp", 1);
	project.edit("ann", { file: "notes.md", old: "two\n", new: "two (exp)\n" }, 2);
	project.publish("ann", "Experiment", 3);

	project.edit("cat", { file: "notes.md", old: "two\n", new: "two (cat)\n" }, 4);
	project.publish("cat", "Cat edits two", 5);

	const refused = project.land("ann", "Land exp", 6);
	assert.equal(refused.ok, false);
	const c = !refused.ok ? refused.collisions[0]! : undefined;
	assert.equal(c?.kind, "lines");
	assert.equal(c?.theirs.agent, "cat");
	assert.equal(c?.yours.text, "two (exp)\n");

	// Move the draft onto shared's newest version; ann syncs and sees both lines.
	assert.deepEqual(project.syncDraft("ann", 7), { draft: "exp", version: 2, sharedBase: 1 });
	const synced = project.sync("ann");
	assert.equal(synced.collisions.length, 1);
	assert.match(synced.files["notes.md"]!, /two \(exp\)\n/);
	assert.match(synced.files["notes.md"]!, /two \(cat\)\n/);

	// ann settles it inside the draft, publishes there, and the draft lands.
	const folder = synced.files["notes.md"]!;
	project.record("ann", { "notes.md": folder.replace(/two \(.*\)\n.*two \(.*\)\n/s, "two (exp and cat)\n") }, 8);
	assert.equal(project.publish("ann", "Settle two", 9).ok, true);
	assert.deepEqual(project.land("ann", "Land exp", 10), { ok: true, version: 2, changes: 4 });
	assert.equal(project.files()["notes.md"], "one\ntwo (exp and cat)\nthree\n");
	const shared = new Set(
		project.graph
			.atoms()
			.map((a) => a.id)
			.filter((id) => project.versionOf(id) !== undefined),
	);
	assert.deepEqual(unresolvedConflicts(project.graph, shared), []);
});

test("the changed-definition rule applies to landing too", () => {
	const { project } = setup();
	project.switchTo("ann", "exp", 1);
	project.edit("ann", { file: "core.ts", old: "export const version = 1;", new: "export const version = step(1);" }, 2);
	project.publish("ann", "Use step", 3);
	project.edit("cat", { file: "core.ts", old: "step(x: number)", new: "step(x: number, by = 1)" }, 4);
	project.publish("cat", "step takes a size", 5);
	const refused = project.land("ann", "Land", 6);
	assert.equal(refused.ok, false);
	assert.equal(!refused.ok && refused.collisions[0]!.kind, "definition");
	project.syncDraft("ann", 7);
	assert.equal(project.land("ann", "Land", 8).ok, true);
});

test("switching parks unpushed work in the space you leave, and switching back restores it", () => {
	const { project } = setup();
	project.edit("ann", { file: "notes.md", old: "one\n", new: "ONE (shared work)\n" }, 1);

	// Plain switch: the shared work is parked, the folder becomes the new draft's view.
	const moved = project.switchTo("ann", "side", 2);
	assert.deepEqual(moved, { version: 0, files: { "notes.md": "one\ntwo\nthree\n" }, collisions: [], draft: "side" });
	assert.deepEqual(project.status().agents[0]!.parked, [{ draft: null, draftChanges: 1 }]);
	assert.equal(project.status().agents[0]!.draftChanges, 0);

	// Work in the draft, unpublished, then go back: the side work parks, the shared work returns.
	project.edit("ann", { file: "notes.md", old: "three\n", new: "THREE (side work)\n" }, 3);
	const back = project.switchTo("ann", null, 4);
	assert.deepEqual(back.files, { "notes.md": "ONE (shared work)\ntwo\nthree\n" });
	assert.deepEqual(project.status().agents[0]!.parked, [{ draft: "side", draftChanges: 1 }]);
	assert.equal(project.status().agents[0]!.draftChanges, 1);

	// And over again: nothing was lost on either side.
	assert.deepEqual(project.switchTo("ann", "side", 5).files, { "notes.md": "one\ntwo\nTHREE (side work)\n" });
	assert.equal(project.publish("ann", "Side work", 6).ok, true);
	assert.deepEqual(project.switchTo("ann", null, 7).files, { "notes.md": "ONE (shared work)\ntwo\nthree\n" });
	assert.equal(project.publish("ann", "Shared work", 8).ok, true);
	assert.equal(project.files()["notes.md"], "ONE (shared work)\ntwo\nthree\n");
	// Switching to where you already are changes nothing.
	assert.deepEqual(project.switchTo("ann", null, 9).files, {});
});

test("carry takes unpushed changes into a new named draft, and only a new one", () => {
	const { project } = setup();
	project.edit("ann", { file: "notes.md", old: "one\n", new: "ONE\n" }, 1);
	const moved = project.switchTo("ann", "idea", 2, { carry: true });
	assert.deepEqual(moved.files, {}, "the folder already has the change");
	assert.equal(project.status().agents[0]!.draftChanges, 1);
	assert.deepEqual(project.status().agents[0]!.parked, []);
	project.publish("ann", "Idea", 3);
	assert.equal(project.version, 0, "it went into the draft, not shared");
	assert.throws(
		() => project.switchTo("ann", "idea", 4, { carry: true }),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);

	// Carrying out of a named draft is refused when the changes build on that draft's own work.
	project.edit("ann", { file: "notes.md", old: "ONE\n", new: "ONE!\n" }, 5);
	assert.throws(
		() => project.switchTo("ann", "idea2", 6, { carry: true }),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
	// A plain switch is always fine: the change stays parked in idea.
	assert.deepEqual(project.switchTo("ann", null, 7).files, { "notes.md": "one\ntwo\nthree\n" });
	assert.deepEqual(project.status().agents[0]!.parked, [{ draft: "idea", draftChanges: 1 }]);
});

test("a log written before parking still loads: its switches carried", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	project.sync("ann");
	project.edit("ann", { file: "notes.md", old: "one\n", new: "ONE\n" }, 1);
	project.switchTo("ann", "old", 2, { carry: true });
	const legacy = store.entries.map((e) =>
		e.type === "switch" ? { type: e.type, agent: e.agent, space: e.space, version: e.version } : e,
	);
	const again = Project.load(legacy as typeof store.entries, new MemoryStore());
	assert.deepEqual(again.status(), project.status());
});

test("news reaches agents in the same space only", () => {
	const { project } = setup();
	project.switchTo("ann", "exp", 1);
	project.switchTo("bob", "exp", 1);
	project.edit("bob", { file: "notes.md", old: "three\n", new: "three (bob)\n" }, 2);
	project.edit("cat", { file: "notes.md", old: "three\n", new: "three (cat)\n" }, 2);
	project.edit("ann", { file: "notes.md", old: "three\n", new: "three (ann)\n" }, 2);
	project.publish("ann", "Ann in exp", 3);
	const bob = project.record("bob", {}, 4);
	const cat = project.record("cat", {}, 4);
	assert.equal(bob.news.length, 1);
	assert.match(bob.news[0]!, /\(draft exp, version 1\)/);
	assert.deepEqual(cat.news, []);
});

test("a reload keeps named drafts", () => {
	const { project, store } = setup();
	project.switchTo("ann", "exp", 1);
	project.edit("ann", { file: "notes.md", old: "one\n", new: "uno\n" }, 2);
	project.publish("ann", "Uno", 3);
	project.syncDraft("ann", 4);
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.status(), project.status());
	assert.equal(again.land("ann", "Land", 5).ok, true);
	assert.equal(again.files()["notes.md"], "uno\ntwo\nthree\n");
});

test("draft calls need a named draft and a good name", () => {
	const { project } = setup();
	assert.throws(
		() => project.land("ann", "x", 1),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
	assert.throws(
		() => project.syncDraft("ann", 1),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
	assert.throws(
		() => project.switchTo("ann", "bad name", 1),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
});
