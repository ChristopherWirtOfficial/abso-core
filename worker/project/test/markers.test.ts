// Collision markers (#11, round 1, ruled 2026-10-05): a sync writes lines
// both sides changed differently between diff3 markers; settled means the
// markers are gone; the other author hears what was kept.

import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksIn, keptOf, lostLines, markerBlock, settleLines } from "../markers.ts";
import { MemoryStore, Project } from "../project.ts";

const GOALS = 'export const GOALS = [\n  "Reach the harbour",\n  "Light the lamp",\n];\n';

function collided() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "src/goals.ts": GOALS, "notes.md": "# notes\n" }, 0);
	for (const a of ["builder1", "writer1"]) project.sync(a);
	project.record("writer1", { "src/goals.ts": GOALS.replace('"Reach the harbour"', '"Sail into Smoke Harbour"') }, 1);
	assert.equal(project.publish("writer1", 'Goal wording "playtest 4"', 2).ok, true);
	project.record("builder1", { "src/goals.ts": GOALS.replace('"Reach the harbour"', '"Reach harbour"') }, 3);
	const synced = project.sync("builder1");
	return { project, store, synced };
}

const theirsLine = ">>>>>>> theirs: writer1, version 1 \"Goal wording 'playtest 4'\"";

test("sync writes the block diff3 style, labeled, and lists it as a marked collision", () => {
	const { project, synced } = collided();
	const text = project.draftOf("builder1")!.view.text("src/goals.ts");
	assert.equal(
		text,
		[
			"export const GOALS = [",
			"<<<<<<< yours (unpublished)",
			'  "Reach harbour",',
			"||||||| before (version 0)",
			'  "Reach the harbour",',
			"=======",
			'  "Sail into Smoke Harbour",',
			theirsLine,
			'  "Light the lamp",',
			"];",
			"",
		].join("\n"),
	);
	assert.deepEqual(synced.collisions, [
		{
			kind: "lines",
			marked: true,
			file: "src/goals.ts",
			yours: { lines: [2, 8], text: '  "Reach harbour",\n' },
			theirs: {
				lines: [2, 8],
				text: '  "Sail into Smoke Harbour",\n',
				agent: "writer1",
				message: "Goal wording 'playtest 4'",
				version: 1,
			},
		},
	]);
	// Their line inside the block is still theirs: blame would name writer1.
	const line = project.draftOf("builder1")!.view.lines("src/goals.ts")[6]!;
	assert.equal(project.graph.atom(line.atom).author, "writer1");
});

test("status lists the open block; an edit to the file says it still needs settling", () => {
	const { project } = collided();
	assert.deepEqual(project.status().agents.find((a) => a.agent === "builder1")!.collisions, [
		{
			file: "src/goals.ts",
			lines: [2, 8],
			theirs: { agent: "writer1", version: 1, message: "Goal wording 'playtest 4'" },
		},
	]);
	assert.equal(project.status().agents.find((a) => a.agent === "writer1")!.collisions, undefined);
	const e = project.edit("builder1", { file: "src/goals.ts", old: '"Light the lamp"', new: '"Light the lamp!"' }, 4);
	assert.deepEqual(e.ok && e.news, [
		"src/goals.ts still has 1 collision block to settle: abso settle src/goals.ts --yours|--theirs|--both",
	]);
	// Once per count: the next edit says nothing more.
	const again = project.edit(
		"builder1",
		{ file: "src/goals.ts", old: '"Light the lamp!"', new: '"Light the lamp."' },
		5,
	);
	assert.deepEqual(again.ok && again.news, []);
});

for (const [keep, kept, phrase] of [
	["theirs", "theirs", "it kept your lines"],
	["yours", "yours", "it kept its own lines, not yours"],
	["both", "both", "it kept both its lines and yours"],
] as const) {
	test(`settled by keeping ${keep}: the publish goes through, logs it, and writer1 hears "${phrase}"`, () => {
		const { project, store } = collided();
		const lines = project
			.draftOf("builder1")!
			.view.lines("src/goals.ts")
			.map((l) => l.text);
		project.record("builder1", { "src/goals.ts": settleLines(lines, keep).lines.join("\n") }, 4);
		const p = project.publish("builder1", "Settled", 5);
		assert.deepEqual(p.ok && p.settled, [{ file: "src/goals.ts", kept, theirs: { agent: "writer1", version: 1 } }]);
		assert.ok(
			project
				.news("writer1")
				.news.includes(
					`builder1 settled its collision with your version 1 in src/goals.ts, publishing version 2: ${phrase}. abso show 2:src/goals.ts shows the file.`,
				),
		);
		assert.deepEqual(project.status().agents.find((a) => a.agent === "builder1")!.collisions, undefined);
		// Logged on the publish, and the log loads back the same.
		const entry = store.entries.find((e) => e.type === "publish" && e.version === 2);
		assert.deepEqual(entry?.type === "publish" && entry.settled, [
			{ file: "src/goals.ts", kept, theirs: { agent: "writer1", version: 1 } },
		]);
		assert.deepEqual(Project.load(store.entries, new MemoryStore()).files(), project.files());
	});
}

test("publish refuses while the markers are in; asIs keeps both, lists the file, and tells writer1", () => {
	const { project } = collided();
	const refused = project.publish("builder1", "Not yet", 4);
	assert.deepEqual(!refused.ok && refused.collisions.map((c) => [c.kind, c.marked, c.file, c.yours.lines]), [
		["lines", true, "src/goals.ts", [2, 8]],
	]);
	const p = project.publish("builder1", "Both belong", 5, { asIs: true });
	assert.deepEqual(p.ok && p.settled, [
		{ file: "src/goals.ts", kept: "both", theirs: { agent: "writer1", version: 1 } },
	]);
	assert.equal(
		project.files()["src/goals.ts"],
		'export const GOALS = [\n  "Reach harbour",\n  "Sail into Smoke Harbour",\n  "Light the lamp",\n];\n',
	);
	assert.equal(project.news("writer1").news.length, 1);
});

test("a marker line left behind is refused; a document that shows markers is not", () => {
	const { project } = collided();
	const lines = project
		.draftOf("builder1")!
		.view.lines("src/goals.ts")
		.map((l) => l.text);
	// Keeps yours, but leaves the closing marker in.
	const kept = settleLines(lines, "yours").lines;
	kept.splice(2, 0, theirsLine);
	project.record("builder1", { "src/goals.ts": kept.join("\n") }, 4);
	const refused = project.publish("builder1", "Stray", 5);
	assert.deepEqual(!refused.ok && refused.collisions.map((c) => [c.marked, c.yours.lines]), [[true, [3, 3]]]);
	project.record("builder1", { "src/goals.ts": settleLines(lines, "yours").lines.join("\n") }, 6);
	project.record(
		"builder1",
		{
			"notes.md": "# notes\n\nGit writes conflicts like this:\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n",
		},
		7,
	);
	assert.equal(project.publish("builder1", "Docs", 8).ok, true);
});

test("the open block survives a reload of the log", () => {
	const { project, store } = collided();
	const loaded = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(
		loaded.status().agents.find((a) => a.agent === "builder1")!.collisions,
		project.status().agents.find((a) => a.agent === "builder1")!.collisions,
	);
	assert.equal(loaded.publish("builder1", "Not yet", 4).ok, false);
});

test("a block is labeled by whose lines are newer, not by an older line it starts with (#37)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "fronts.ts": "a\nb\nc\nd\n" }, 0);
	for (const a of ["builder3", "artist1"]) project.sync(a);
	project.edit("builder3", { file: "fronts.ts", old: "b\n", new: "b by builder3\n" }, 1);
	project.publish("builder3", "Storm card", 2);
	for (const a of ["builder3", "artist1"]) project.sync(a);
	project.edit("artist1", { file: "fronts.ts", old: "c\n", new: "c by artist1\n" }, 3);
	project.publish("artist1", "Fronts art", 4);
	// builder3's draft changes both lines: the block's theirs side starts with builder3's own older line.
	project.edit("builder3", { file: "fronts.ts", old: "b by builder3\nc\n", new: "b again\nc again\n" }, 5);
	const s = project.sync("builder3");
	assert.deepEqual(
		s.collisions.map((c) => [c.marked, c.theirs.agent, c.theirs.version, c.theirs.message]),
		[[true, "artist1", 2, "Fronts art"]],
	);
	assert.match(
		project.draftOf("builder3")!.view.text("fronts.ts"),
		/^>>>>>>> theirs: artist1, version 2 "Fronts art"$/m,
	);
});

test("a settle that loses lines both sides still had says so, to the settler and the other author (#37)", () => {
	const notes =
		"# playtest\n- [ ] **Beam engine on a Cove with no lighthouse**\n  Check it feeds the Fjord.\n- [ ] **Gauge**\n";
	const project = new Project(new MemoryStore());
	project.init({ "notes.md": notes }, 0);
	for (const a of ["builder5", "tester1"]) project.sync(a);
	project.edit(
		"tester1",
		{ file: "notes.md", old: "  Check it feeds the Fjord.\n", new: "  Check it feeds the Fjord. *T1: still open*\n" },
		1,
	);
	project.publish("tester1", "Retest", 2);
	project.edit(
		"builder5",
		{
			file: "notes.md",
			old: "- [ ] **Beam engine on a Cove with no lighthouse**\n  Check it feeds the Fjord.\n",
			new: "- [x] **Beam engine on a Cove with no lighthouse**\n  Check it feeds the Fjord. *B5: fixed*\n",
		},
		3,
	);
	project.sync("builder5");
	// The settle drops the item's header and its annotation line, and keeps only the next item.
	project.record("builder5", { "notes.md": "# playtest\n- [ ] **Gauge**\n" }, 4);
	const p = project.publish("builder5", "Tick", 5);
	assert.deepEqual(p.ok && p.settled, [
		{
			file: "notes.md",
			kept: "rewrote",
			theirs: { agent: "tester1", version: 1 },
			lost: ["- [x] **Beam engine on a Cove with no lighthouse**", "  Check it feeds the Fjord. *B5: fixed*"],
		},
	]);
	assert.match(
		project.news("tester1").news[0]!,
		/It also lost 2 lines you both still had: "- \[x\] \*\*Beam engine on a Cove with no lighthouse\*\*", "Check it feeds the Fjord\. \*B5: fixed\*"\./,
	);
});

test("lostLines: a rewording is not a loss; a line gone in every version is", () => {
	const region = {
		file: "n.md",
		yours: ["- [x] **Gauge shows coin**", "  rate. *B1: sellers too*"],
		base: ["- [ ] **Gauge shows coin**", "  rate."],
		theirs: ["- [ ] **Gauge shows coin**", "  rate. *B5: worth +N coin*"],
		agent: "t",
		version: 1,
		message: "m",
	};
	assert.deepEqual(
		lostLines(["- [x] **Gauge shows coin**", "  rate. *B5: worth +N coin* *B1: sellers too*"], region),
		[],
	);
	assert.deepEqual(lostLines(["  rate. *B5: worth +N coin*"], region), ["- [x] **Gauge shows coin**"]);
});

test("markers.ts: blocks round-trip, settle, and say what was kept", () => {
	const who = { agent: "a", version: 3, message: 'Line one\nline two "quoted"' };
	const block = markerBlock(["y1", "y2"], ["b"], 2, ["t1"], who);
	assert.deepEqual(block, [
		"<<<<<<< yours (unpublished)",
		"y1",
		"y2",
		"||||||| before (version 2)",
		"b",
		"=======",
		"t1",
		'>>>>>>> theirs: a, version 3 "Line one"',
	]);
	const lines = ["top", ...block, "bottom"];
	assert.deepEqual(blocksIn(lines), [
		{ start: 1, end: 8, yours: ["y1", "y2"], base: ["b"], theirs: ["t1"], agent: "a", version: 3, message: "Line one" },
	]);
	assert.deepEqual(settleLines(lines, "both").lines, ["top", "y1", "y2", "t1", "bottom"]);
	const region = { file: "f", yours: ["y1", "y2"], base: ["b"], theirs: ["t1"], ...who };
	assert.equal(keptOf(["top", "t1", "bottom"], region), "theirs");
	assert.equal(keptOf(["top", "y1", "y2", "bottom"], region), "yours");
	assert.equal(keptOf(["top", "new", "bottom"], region), "rewrote");
	// A side that deleted its lines is kept when the other side's lines are gone.
	assert.equal(keptOf(["top", "bottom"], { ...region, yours: [] }), "yours");
});

test("keeping both, with an edit to a line their block left as it was, is both, not yours (#37)", () => {
	// The real region from the game log: writer1 added the isle-glut hint above the
	// isle-welcome line it left alone; builder2 rewrote isle-welcome and added a comment.
	const welcome =
		"  { id: 'isle-welcome', when: () => true, text: 'Coral Isle. Buildings here cost pearls: click the dive boat to dive for them.' },";
	const glut =
		"  { id: 'isle-glut', when: (s) => !lv(s, 'lagoonmarket'), text: 'Fish is piling up with nowhere to sell it.' },";
	const comment = "  // Goes once the first dive is made (playtest 7: it outstayed it).";
	const mine =
		"  { id: 'isle-welcome', when: (s) => !s.ext.isle?.dives, text: 'Coral Isle. Buildings here cost pearls: click the dive boat to dive for them.', transient: true },";
	const region = {
		file: "src/render/hints.ts",
		yours: [comment, mine],
		base: [welcome],
		theirs: [glut, welcome],
		agent: "writer1",
		version: 533,
		message: "hints",
	};
	assert.equal(keptOf(["export const HINTS = [", glut, comment, mine, "];"], region), "both");
	assert.equal(keptOf(["export const HINTS = [", glut, welcome, "];"], region), "theirs");
	assert.equal(keptOf(["export const HINTS = [", comment, mine, "];"], region), "yours");
	// Their hint kept, but only half of builder2's change (no comment): part of a side is a rewrite.
	assert.equal(keptOf(["export const HINTS = [", glut, mine, "];"], region), "rewrote");
	assert.equal(keptOf(["export const HINTS = [", glut, comment, welcome, "];"], region), "rewrote");
	assert.equal(keptOf(["export const HINTS = [", "  { id: 'new' },", "];"], region), "rewrote");
});
