// Who has heard a tell, and when: status's tells, read from the news and heard
// entries the log already keeps, so a page can show each recipient's mark fill.

import assert from "node:assert/strict";
import { test } from "node:test";
import { TELLS_KEPT } from "../apply-entry.ts";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.ts": "x\n" }, 0);
	for (const a of ["lead", "b1", "b2"]) project.sync(a);
	return { project, store };
}

test("a tell lists each recipient, and marks one heard when its news is handed over, with the time", () => {
	const { project, store } = setup();
	const before = Date.now();
	const sent = project.announce("lead", "Stand-up soon.", ["b1", "b2"], 1);
	let tell = project.status().tells[0]!;
	assert.equal(tell.id, sent.id);
	assert.equal(tell.text, "Announcement from lead (as claimed): Stand-up soon.");
	assert.ok(tell.at !== null && tell.at >= before);
	assert.deepEqual(
		tell.to.map((t) => [t.agent, t.heard]),
		[
			["b1", false],
			["b2", false],
		],
	);
	assert.deepEqual(project.news("b1").news, ["Announcement from lead (as claimed): Stand-up soon."]);
	tell = project.status().tells[0]!;
	const b1 = tell.to.find((t) => t.agent === "b1")!;
	assert.equal(b1.heard, true);
	assert.ok(b1.at !== null && b1.at >= tell.at!);
	assert.deepEqual(
		tell.to.find((t) => t.agent === "b2"),
		{ agent: "b2", heard: false, at: null },
	);
	// Heard tells stay listed (announcements lists only what's undelivered), and the log loads back the same.
	assert.deepEqual(project.status().announcements[0]!.waiting, ["b2"]);
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).status().tells, project.status().tells);
});

test("a pull's reset hears no tell, two tells with the same words stay two, and only the newest are kept", () => {
	const { project } = setup();
	project.announce("lead", "Same words.", ["b1"], 1);
	project.announce("lead", "Same words.", ["b1"], 2);
	project.sync("b1");
	const tells = project.status().tells;
	assert.equal(tells.length, 2);
	assert.ok(tells[0]!.id > tells[1]!.id, "newest first");
	assert.ok(
		tells.every((t) => !t.to[0]!.heard),
		"a pull keeps announcements, so nothing is heard",
	);
	for (let i = 0; i < TELLS_KEPT + 3; i++) project.announce("lead", `Tell ${i}.`, ["b2"], 3 + i);
	const kept = project.status().tells;
	assert.equal(kept.length, TELLS_KEPT);
	assert.match(kept[0]!.text, new RegExp(`Tell ${TELLS_KEPT + 2}\\.$`));
});

test("a person's tell is kept like an agent's", () => {
	const { project } = setup();
	project.announcePerson({ id: "cf-1", name: "Robin" }, "From the website.", ["b2"], 5);
	const tell = project.status().tells[0]!;
	assert.equal(tell.at, 5);
	assert.deepEqual(
		tell.to.map((t) => t.agent),
		["b2"],
	);
});
