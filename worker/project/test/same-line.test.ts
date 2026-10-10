// Both sides changing the same line (#37): a sync
// showed the collision with both lines in the file, and the next sync, on
// unrelated work, merged from a base that already had their line. The draft's
// copy of both lines then read as the draft adding one, and the collision was
// gone with both lines kept. Since #11 the first sync writes markers, and they
// stay until the agent settles them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const GAUGE = [
	"export function drawHeader(ctx: Ctx, b: Boiler, hot: number) {",
	"  ctx.fillText('Boiler', 14, 24);",
	"  ctx.fillText(b.stall > 0 ? 'valve blown' : `works ×${b.bonus}`, 186, 24);",
	"}",
	"",
].join("\n");

function setup() {
	const project = new Project(new MemoryStore());
	project.init({ "src/smoke/gauge.ts": GAUGE, "src/other.ts": "export const other = 1;\n" }, 0);
	for (const a of ["writer1", "builder5", "tester1"]) project.sync(a);
	// writer1 changes the words; builder5 adds a third case to the same line, and a line of its own above.
	project.edit(
		"writer1",
		{ file: "src/smoke/gauge.ts", old: "'valve blown' : `works", new: "'valve lifted' : `all output" },
		1,
	);
	assert.equal(project.publish("writer1", "Words", 2).ok, true);
	project.record(
		"builder5",
		{
			"src/smoke/gauge.ts": GAUGE.replace("'Boiler', 14, 24);", "'Boiler', 14, 24);\n  ctx.fillStyle = 'red';").replace(
				"'valve blown' : `works",
				"'valve blown' : hot > 0.3 ? 'ease off!' : `works",
			),
		},
		3,
	);
	return project;
}

const markerLines = (text: string) =>
	text.split("\n").filter((l) => /^(<<<<<<< yours|\|\|\|\|\|\|\| before|=======$|>>>>>>> theirs)/.test(l));

test("a same-line collision a pull showed, with markers, still stands after the next pull brings unrelated work", () => {
	const project = setup();
	const first = project.sync("builder5");
	assert.deepEqual(
		first.collisions.map((c) => [c.kind, c.marked, c.theirs.agent, c.theirs.version]),
		[["lines", true, "writer1", 1]],
	);
	assert.equal(markerLines(project.draftOf("builder5")!.view.text("src/smoke/gauge.ts")).length, 4);
	// Someone else publishes something unrelated; builder5 syncs again.
	project.edit("tester1", { file: "src/other.ts", old: "1", new: "2" }, 4);
	assert.equal(project.publish("tester1", "Other", 5).ok, true);
	const second = project.sync("builder5");
	assert.deepEqual(
		second.collisions.map((c) => [c.kind, c.marked]),
		[["lines", true]],
	);
	assert.equal(second.merged, undefined);
	assert.equal(markerLines(project.draftOf("builder5")!.view.text("src/smoke/gauge.ts")).length, 4);
	assert.equal(project.publish("builder5", "Third case", 6).ok, false);
});

test("settling it by editing the block to one line lets the push through, and writer1 hears what was kept", () => {
	const project = setup();
	project.sync("builder5");
	const text = project.draftOf("builder5")!.view.text("src/smoke/gauge.ts");
	const lines = text.split("\n");
	const start = lines.indexOf("<<<<<<< yours (unpublished)");
	const end = lines.findIndex((l) => l.startsWith(">>>>>>> theirs: "));
	const one =
		"  ctx.fillText(b.stall > 0 ? 'valve lifted' : hot > 0.3 ? 'ease off!' : `all output ×${b.bonus}`, 186, 24);";
	project.record(
		"builder5",
		{ "src/smoke/gauge.ts": [...lines.slice(0, start), one, ...lines.slice(end + 1)].join("\n") },
		4,
	);
	const published = project.publish("builder5", "Third case on the new words", 5);
	assert.deepEqual(published.ok && published.settled, [
		{ file: "src/smoke/gauge.ts", kept: "rewrote", theirs: { agent: "writer1", version: 1 } },
	]);
	assert.equal(
		project
			.files()
			["src/smoke/gauge.ts"]!.split("\n")
			.filter((l) => l.includes("186, 24")).length,
		1,
	);
	const heard = project.news("writer1").news;
	assert.ok(
		heard.includes(
			"builder5 settled its collision with your version 1 in src/smoke/gauge.ts, pushing version 2: it kept part of each side or rewrote them. abso show 2:src/smoke/gauge.ts shows the file.",
		),
		heard.join("\n"),
	);
});
