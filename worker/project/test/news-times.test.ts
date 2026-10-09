// When each piece of news was made (abso issue 124): news hands over each
// item's time with its text, from the log, so a replay gives the same times.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "a\n" }, 0);
	for (const a of ["builder1", "builder2"]) project.sync(a);
	return { project, store };
}

test("news hands over each item's time with its text", () => {
	const { project } = setup();
	project.announcePerson({ id: "cf-1", name: "C" }, "first", ["builder2"], 1_000);
	const before = Date.now();
	project.announce("builder1", "second", ["builder2"], 2_000);
	const { news, items } = project.news("builder2");
	assert.deepEqual(
		items.map((i) => i.text),
		news,
	);
	assert.equal(items[0]!.at, 1_000);
	assert.ok(items[1]!.at !== null && items[1]!.at >= before, "an agent's announcement is stamped when it's queued");
	assert.deepEqual(project.news("builder2").items, [], "handed over once");
});

test("a replay of the log gives the same times, and news from before times has none", () => {
	const { project, store } = setup();
	project.announcePerson({ id: "cf-1", name: "C" }, "kept", ["builder1"], 1_000);
	const replayed = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(replayed.news("builder1").items, [
		{ text: 'Announcement from C (a person, signed in on the website, id cf-1): "kept"', at: 1_000 },
	]);
	const old = store.entries.map((e) => {
		if (e.type !== "news") return e;
		const { time: _time, ...rest } = e;
		return rest;
	});
	assert.equal(Project.load(old, new MemoryStore()).news("builder1").items[0]!.at, null);
});
