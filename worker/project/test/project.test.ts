import assert from "node:assert/strict";
import { test } from "node:test";
import { unresolvedConflicts } from "../../../src/engine/index.ts";
import { type Files, MemoryStore, Project, ProjectError } from "../project.ts";

const START = {
	"engine.ts": "export function match(p, s) {\n  return null;\n}\n",
	"notes.md": "one\ntwo\nthree\nfour\nfive\n",
};

function setup(files: Record<string, string> = START): { project: Project; store: MemoryStore } {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(files, 1);
	return { project, store };
}

/** A folder that follows what the server hands back, like the client does. */
function apply(folder: Record<string, string>, files: Files): void {
	for (const [path, text] of Object.entries(files)) {
		if (text === null) delete folder[path];
		else folder[path] = text;
	}
}

test("a first pull hands back every file, empty ones included", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	assert.deepEqual(project.init({ ...START, "empty.txt": "" }, 1), { version: 0, skipped: [] });
	const answer = project.sync("backtracker");
	assert.equal(answer.version, 0);
	assert.deepEqual(answer.files, { ...START, "empty.txt": "" });
	assert.deepEqual(answer.collisions, []);
	assert.deepEqual(project.sync("backtracker").files, {});
});

test("an edit joins the draft, push adds it to shared, and pull brings it to others", () => {
	const { project } = setup();
	project.sync("a");
	project.sync("b");
	assert.deepEqual(project.edit("a", { file: "notes.md", old: "two\n", new: "TWO\n" }, 2), { ok: true, news: [] });
	assert.deepEqual(project.status().agents, [
		{
			agent: "a",
			draft: null,
			base: 0,
			draftChanges: 1,
			files: ["notes.md"],
			parked: [],
			edits: "commands",
			modCurrent: null,
			lastEdit: 2,
			joined: 1,
		},
		{
			agent: "b",
			draft: null,
			base: 0,
			draftChanges: 0,
			files: [],
			parked: [],
			edits: "none",
			modCurrent: null,
			lastEdit: null,
			joined: 3,
		},
	]);
	assert.deepEqual(project.publish("a", "Shout two", 3), { ok: true, version: 1, changes: 1 });
	assert.equal(project.files()["notes.md"], "one\nTWO\nthree\nfour\nfive\n");
	assert.deepEqual(project.published(1), { agent: "a", message: "Shout two", time: 3 });
	const b = project.sync("b");
	assert.deepEqual(b, { version: 1, files: { "notes.md": "one\nTWO\nthree\nfour\nfive\n" }, collisions: [] });
	assert.equal(project.status().agents[0]!.base, 1);
});

test("an edit whose old text is not there exactly once is out of step", () => {
	const { project } = setup();
	project.sync("a");
	assert.deepEqual(project.edit("a", { file: "notes.md", old: "six\n", new: "x\n" }, 2), {
		ok: false,
		reason: "out of step",
	});
	assert.deepEqual(project.edit("a", { file: "engine.ts", old: "n", new: "x" }, 2), {
		ok: false,
		reason: "out of step",
	});
	assert.deepEqual(project.edit("a", { file: "missing.ts", old: "x", new: "y" }, 2), {
		ok: false,
		reason: "out of step",
	});
	assert.equal(project.status().agents[0]!.draftChanges, 0);
});

test("Write and MultiEdit, and record creates, changes and deletes files", () => {
	const { project } = setup();
	project.sync("a");
	project.edit("a", { file: "new.ts", content: "export const x = 1;\n" }, 2);
	project.edit(
		"a",
		{
			file: "notes.md",
			edits: [
				{ old: "one\n", new: "ONE\n" },
				{ old: "ONE\ntwo", new: "ONE\n2" },
			],
		},
		3,
	);
	assert.equal(project.edit("a", { file: "notes.md", edits: [{ old: "zzz", new: "y" }] }, 3).ok, false);
	const r = project.record(
		"a",
		{ "engine.ts": null, "other.ts": "let y\r\n", "notes.md": "ONE\n2\nthree\nfour\nfive\n" },
		4,
	);
	assert.deepEqual(r, { ok: true, changed: ["engine.ts", "other.ts"], news: [] });
	project.publish("a", "Rework", 5);
	assert.deepEqual(project.files(), {
		"new.ts": "export const x = 1;\n",
		"notes.md": "ONE\n2\nthree\nfour\nfive\n",
		"other.ts": "let y\n",
	});
});

test("changes that do not collide push in any order and give the same files", () => {
	const edits: [string, string, string, string][] = [
		["a", "notes.md", "one\n", "uno\n"],
		["b", "notes.md", "four\n", "cuatro\n"],
		["c", "engine.ts", "  return null;\n", "  return [];\n"],
		["d", "added.ts", "", "export {};\n"],
	];
	const orders = [
		[0, 1, 2, 3],
		[3, 2, 1, 0],
		[1, 3, 0, 2],
		[2, 0, 3, 1],
	];
	const results = orders.map((order) => {
		const { project } = setup();
		for (const [agent] of edits) project.sync(agent);
		for (const [agent, file, old, nu] of edits) {
			if (old === "") project.edit(agent, { file, content: nu }, 2);
			// No collision news; b hears only that a is in notes.md too (#37).
			else {
				const a = project.edit(agent, { file, old, new: nu }, 2);
				assert.deepEqual(a.ok && a.news.filter((n) => !n.includes("which you just started changing")), []);
			}
		}
		for (const i of order) {
			const [agent] = edits[i]!;
			assert.equal(project.publish(agent, `from ${agent}`, 3).ok, true, `push by ${agent}`);
		}
		return project.files();
	});
	for (const r of results) assert.deepEqual(r, results[0]);
	assert.deepEqual(results[0], {
		"added.ts": "export {};\n",
		"engine.ts": "export function match(p, s) {\n  return [];\n}\n",
		"notes.md": "uno\ntwo\nthree\ncuatro\nfive\n",
	});
});

test("a collision refuses the push, sends news, and pull then an edit settles it", () => {
	const { project } = setup();
	const folderB: Record<string, string> = {};
	apply(folderB, project.sync("a").files);
	apply(folderB, project.sync("b").files);

	project.edit("b", { file: "notes.md", old: "three\n", new: "THREE (b)\n" }, 2);
	project.edit("a", { file: "notes.md", old: "three\n", new: "three (a)\n" }, 3);
	assert.deepEqual(project.publish("a", "Mark three for a", 4), { ok: true, version: 1, changes: 1 });

	// b hears about it with its next edit.
	const heard = project.edit("b", { file: "engine.ts", old: "return null", new: "return undefined" }, 5);
	assert.equal(heard.ok, true);
	assert.deepEqual(heard.ok && heard.news, [
		'a pushed "Mark three for a" (version 1), which changes notes.md lines 3-3, where your draft also changes lines; run abso pull to see both versions.',
	]);
	assert.deepEqual(project.edit("b", { file: "engine.ts", old: "undefined", new: "void 0" }, 5), {
		ok: true,
		news: [],
	});

	const refused = project.publish("b", "Mark three for b", 6);
	assert.equal(refused.ok, false);
	assert.deepEqual(!refused.ok && refused.collisions, [
		{
			kind: "lines",
			file: "notes.md",
			yours: { lines: [3, 3], text: "THREE (b)\n" },
			theirs: { lines: [3, 3], text: "three (a)\n", agent: "a", message: "Mark three for a", version: 1 },
		},
	]);
	assert.equal(project.version, 1);

	// Sync brings both versions into b's file between markers (#11), and lists the collision.
	const synced = project.sync("b");
	apply(folderB, synced.files);
	assert.deepEqual(
		synced.collisions.map((c) => [c.kind, c.marked, c.yours.lines]),
		[["lines", true, [3, 9]]],
	);
	const block =
		'<<<<<<< yours (unpublished)\nTHREE (b)\n||||||| before (version 0)\nthree\n=======\nthree (a)\n>>>>>>> theirs: a, version 1 "Mark three for a"\n';
	assert.equal(folderB["notes.md"], `one\ntwo\n${block}four\nfive\n`);
	assert.deepEqual(Object.keys(synced.files), ["notes.md"]); // b's own engine.ts edit was already in its folder

	// b settles it with an edit that takes the markers out, and publish goes through, saying what b kept.
	project.edit("b", { file: "notes.md", old: block, new: "three (a and b)\n" }, 7);
	const settled = project.publish("b", "Settle three", 8);
	assert.deepEqual(settled.ok && "version" in settled && [settled.version, settled.settled], [
		2,
		[{ file: "notes.md", kept: "rewrote", theirs: { agent: "a", version: 1 } }],
	]);
	assert.equal(project.files()["notes.md"], "one\ntwo\nthree (a and b)\nfour\nfive\n");
	assert.equal(project.files()["engine.ts"], "export function match(p, s) {\n  return void 0;\n}\n");
	// Shared, not every atom: a sync that writes markers (#11) discards the draft change it replaces.
	const shared = project.sharedView().set;
	assert.deepEqual(unresolvedConflicts(project.graph, shared), []);
});

test("pushing with the markers still in is refused; asIs pushes both and settles it (#37, #11)", () => {
	const { project } = setup();
	project.sync("a");
	project.sync("b");
	project.edit("a", { file: "notes.md", old: "two\n", new: "two-a\n" }, 2);
	project.edit("b", { file: "notes.md", old: "two\n", new: "two-b\n" }, 2);
	project.publish("a", "a", 3);
	assert.equal(project.publish("b", "b", 4).ok, false);
	assert.equal(project.sync("b").collisions.length, 1);
	const marked = project.publish("b", "Keep both lines", 5);
	assert.deepEqual(!marked.ok && marked.collisions.map((c) => [c.kind, c.marked]), [["lines", true]]);
	assert.equal(project.publish("b", "Keep both lines", 5, { asIs: true }).ok, true);
	assert.equal(project.files()["notes.md"], "one\ntwo-b\ntwo-a\nthree\nfour\nfive\n");
	const shared = project.sharedView().set;
	assert.deepEqual(unresolvedConflicts(project.graph, shared), []);
});

test("after pushing without pulling, the agent keeps editing its own folder", () => {
	const { project } = setup();
	project.sync("a");
	project.sync("b");
	project.edit("b", { file: "notes.md", old: "five\n", new: "five-b\n" }, 2);
	project.publish("b", "b first", 3);
	project.edit("a", { file: "notes.md", old: "one\n", new: "one-a\n" }, 4);
	assert.equal(project.publish("a", "a after b", 5).ok, true);
	// a's folder still says "five": an edit against it must match.
	assert.deepEqual(project.edit("a", { file: "notes.md", old: "one-a\ntwo\n", new: "one-a\n2\n" }, 6), {
		ok: true,
		news: [],
	});
	assert.equal(project.status().agents[0]!.base, 0);
	const s = project.sync("a");
	assert.deepEqual(s.files, { "notes.md": "one-a\n2\nthree\nfour\nfive-b\n" });
	// With nobody else in between, publishing moves the base along.
	project.sync("b");
	project.edit("b", { file: "notes.md", old: "three\n", new: "3\n" }, 7);
	project.publish("b", "b again", 8);
	assert.equal(project.status().agents[1]!.base, project.version);
});

test("a reloaded project is the same project and keeps going", () => {
	const { project, store } = setup();
	project.sync("a");
	project.sync("b");
	project.edit("a", { file: "notes.md", old: "two\n", new: "two-a\n" }, 2);
	project.edit("b", { file: "notes.md", old: "two\n", new: "two-b\n" }, 2);
	project.publish("a", "a", 3);
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.status(), project.status());
	assert.deepEqual(again.files(), project.files());
	// The news b hasn't heard yet survives the reload.
	const heard = again.record("b", {}, 4);
	assert.equal(heard.news.length, 1);
	assert.equal(again.publish("b", "b", 5).ok, false);
});

test("bad input is a ProjectError", () => {
	const { project } = setup();
	assert.throws(
		() => project.sync("bad name"),
		(e) => e instanceof ProjectError && e.code === "bad-agent",
	);
	assert.throws(
		() => project.init({}, 1),
		(e) => e instanceof ProjectError && e.code === "already-initialized",
	);
	assert.throws(
		() => new Project(new MemoryStore()).status(),
		(e) => e instanceof ProjectError && e.code === "not-initialized",
	);
	assert.throws(
		() => project.edit("a", { file: "", content: "x" }, 1),
		(e) => e instanceof ProjectError && e.code === "bad-request",
	);
});

test("each call stores what it changed in one append", () => {
	const store = new MemoryStore();
	const calls: number[] = [];
	const counting = {
		append: (e: readonly unknown[]) => {
			calls.push(e.length);
			store.append(e as never);
		},
	};
	const project = new Project(counting);
	project.init(START, 1);
	project.sync("a");
	assert.deepEqual(project.status().version, 0); // status writes nothing
	project.edit("a", { file: "notes.md", old: "one\n", new: "1\n" }, 2);
	project.publish("a", "m", 3);
	assert.deepEqual(calls, [1, 2, 1, 1]);
	assert.deepEqual(
		store.entries.map((e) => e.type),
		["init", "join", "sync", "draft", "publish"],
	);
});

test("a call that joins an agent and then throws still stores the join, so the log loads", () => {
	// From the live drafts-smoke project: a new agent's first call was a switch
	// to a bad draft name; its join was applied but never stored, and the
	// agent's next sync made a log that no longer loaded.
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	assert.throws(() => project.switchTo("newbie", "bad name!", 1));
	project.sync("newbie");
	assert.deepEqual(
		store.entries.map((e) => e.type),
		["init", "join", "sync"],
	);
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).status(), project.status());
});

test("a log already missing a join loads: the join is put back at the version it had", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	project.edit("ann", { file: "a.txt", old: "a", new: "b" }, 1);
	project.publish("ann", "b", 2);
	project.sync("bob");
	const broken = store.entries.filter((e) => !(e.type === "join" && e.agent === "bob"));
	const loaded = Project.load(broken, new MemoryStore());
	assert.deepEqual(loaded.status(), project.status());
	assert.deepEqual(loaded.files(), project.files());
});

test("a refused push is logged and counted, and the counts survive a reload", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	project.sync("ann");
	project.sync("bob");
	project.edit("ann", { file: "a.txt", old: "a", new: "b" }, 1);
	project.edit("bob", { file: "a.txt", old: "a", new: "c" }, 1);
	project.publish("ann", "b", 2);
	assert.equal(project.publish("bob", "c", 3).ok, false);
	assert.deepEqual(project.status().refusals, { total: 1, lines: 1, definition: 0, attribute: 0, duplicate: 0 });
	assert.deepEqual(project.refusals().refusals, [
		{ agent: "bob", draft: null, via: "publish", time: 3, collisions: [{ kind: "lines", file: "a.txt" }] },
	]);
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).refusals(), project.refusals());
});

test("a full pull answers every file in the view, even for an agent that pulled before; file listings change nothing (#37)", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n", "src/b.ts": "b\n" }, 0);
	project.sync("artist1");
	project.edit("lead", { file: "src/c.ts", content: "c\n" }, 1);
	project.publish("lead", "c", 2);
	// A plain sync gives only what changed since; a full one, everything.
	assert.deepEqual(Object.keys(project.sync("artist1").files), ["src/c.ts"]);
	assert.deepEqual(Object.keys(project.sync("artist1", { full: true }).files), ["a.txt", "src/b.ts", "src/c.ts"]);
	const before = store.entries.length;
	assert.deepEqual(project.agentPaths("artist1"), {
		version: 1,
		draft: null,
		files: ["a.txt", "src/b.ts", "src/c.ts"],
	});
	assert.deepEqual(project.pathsAt(0), { version: 0, draft: null, files: ["a.txt", "src/b.ts"] });
	assert.equal(store.entries.length, before, "reading the listings logs nothing");
	assert.throws(() => project.agentPaths("nobody"), /join first/);
});

test("a log entry of a kind this engine doesn't know stops the load instead of being skipped", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	const entries = [
		...store.entries,
		{ type: "from-the-future", agent: "x", time: 1 } as unknown as (typeof store.entries)[number],
	];
	assert.throws(
		() => Project.load(entries, new MemoryStore()),
		/log entry 1 is of kind "from-the-future", which this version of abso doesn't know/,
	);
});
