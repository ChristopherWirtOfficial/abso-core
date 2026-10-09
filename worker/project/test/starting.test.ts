// Seeing overlap before it happens (#37; #13): a
// starting note says what an agent is taking on before any edit lands, and
// the first edit to a file someone else is working on brings one line of
// news. Neither ever stops an edit or a publish.

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesPattern, pathsInText, patternsMeet } from "../globs.ts";
import { type EditBody, MemoryStore, Project } from "../project.ts";

/** An edit that must go through: its news. */
function edit(project: Project, agent: string, body: EditBody, time: number): { news: string[] } {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
	return a;
}

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(
		{
			"src/storm/storm.ts": "export const storm = 1;\n",
			"src/storm/system.ts": "export const system = 1;\n",
			"notes/todo.md": "# todo\n",
		},
		0,
	);
	for (const a of ["builder3", "builder6", "writer1"]) project.sync(a);
	return { project, store };
}

test("the first edit to a file in someone else's unpublished draft brings one line of news, once", () => {
	const { project } = setup();
	edit(project, "builder3", { file: "src/storm/storm.ts", old: "1", new: "2" }, 1);
	edit(project, "builder3", { file: "src/storm/system.ts", old: "1", new: "2" }, 2);
	const first = edit(project, "builder6", { file: "src/storm/storm.ts", old: "storm = 1", new: "storm = 3" }, 3);
	assert.equal(first.news.length, 1);
	assert.match(
		first.news[0]!,
		/^builder3 has unpublished changes in src\/storm\/storm\.ts, which you just started changing/,
	);
	// Its second edit to the same file says nothing more; a new file does.
	assert.deepEqual(
		edit(project, "builder6", { file: "src/storm/storm.ts", old: "storm = 3", new: "storm = 4" }, 4).news,
		[],
	);
	const second = project.record("builder6", { "src/storm/system.ts": "export const system = 5;\n" }, 5);
	assert.equal(second.news.length, 1);
	assert.match(second.news[0]!, /^builder3 has unpublished changes in src\/storm\/system\.ts/);
	// A file nobody else is in: no news.
	assert.deepEqual(
		edit(project, "builder6", { file: "notes/todo.md", old: "# todo", new: "# todo\n- storm" }, 6).news,
		[],
	);
});

test("a starting note shows in where-style notes and status before any edit, and the answer names who is already there", () => {
	const { project } = setup();
	edit(project, "builder3", { file: "src/storm/storm.ts", old: "1", new: "2" }, 1);
	const a = project.starting(
		"builder6",
		"Storm cloud art (playtest-2 item 4)",
		["src/storm/storm.ts", "src/storm/art.ts"],
		2,
	);
	assert.deepEqual(a.starting, {
		text: "Storm cloud art (playtest-2 item 4)",
		files: ["src/storm/art.ts", "src/storm/storm.ts"],
		time: 2,
	});
	assert.deepEqual(a.overlaps, [{ agent: "builder3", file: "src/storm/storm.ts", changes: 1 }]);
	assert.deepEqual(project.startingNotes(), [
		{
			agent: "builder6",
			draft: null,
			text: "Storm cloud art (playtest-2 item 4)",
			files: ["src/storm/art.ts", "src/storm/storm.ts"],
			time: 2,
		},
	]);
	assert.equal(
		project.status().agents.find((s) => s.agent === "builder6")!.starting!.text,
		"Storm cloud art (playtest-2 item 4)",
	);
	// builder3 hears of it with its next edit.
	const heard = edit(project, "builder3", { file: "src/storm/storm.ts", old: "2", new: "7" }, 3);
	assert.equal(heard.news.length, 1);
	assert.match(
		heard.news[0]!,
		/^builder6 says it is starting on "Storm cloud art \(playtest-2 item 4\)", naming src\/storm\/storm\.ts/,
	);
});

test("a first edit to a file named in someone's starting note brings news, before that agent has edited anything", () => {
	const { project } = setup();
	project.starting("writer1", "Smoke Harbour goal card", ["notes/todo.md"], 1);
	const n = edit(project, "builder6", { file: "notes/todo.md", old: "# todo", new: "# todo\n- goal card" }, 2);
	assert.equal(n.news.length, 1);
	assert.match(
		n.news[0]!,
		/^writer1 says it is starting on notes\/todo\.md \("Smoke Harbour goal card"\), which you just started changing/,
	);
});

test("a starting note lasts through publishes until taken back, the next start, or 2 hours idle (#44); nothing is locked or refused", () => {
	const { project, store } = setup();
	project.starting("builder3", "Storm", ["src/storm/storm.ts"], 1);
	// Someone else can still edit and publish the file.
	edit(project, "builder6", { file: "src/storm/storm.ts", old: "1", new: "2" }, 2);
	assert.equal(project.publish("builder6", "Mine", 3).ok, true);
	project.sync("builder3");
	edit(project, "builder3", { file: "src/storm/storm.ts", old: "2", new: "3" }, 4);
	assert.equal(project.startingNotes().length, 1);
	assert.equal(project.publish("builder3", "Storm", 5).ok, true);
	assert.deepEqual(
		project.startingNotes().map((n) => n.text),
		["Storm"],
		"a publish no longer ends it",
	);
	// Two hours and a bit with nothing from builder3: it has ended.
	assert.equal(
		Project.load(store.entries, new MemoryStore(), { now: () => 5 + 2 * 60 * 60 * 1000 + 1 }).startingNotes().length,
		0,
	);
	// The next start replaces it.
	project.starting("builder3", "Storm, part two", undefined, 6);
	assert.deepEqual(
		project.startingNotes().map((n) => n.text),
		["Storm, part two"],
	);
	project.starting("builder3", null, undefined, 6);
	project.starting("writer1", "Docs", undefined, 6);
	assert.equal(project.startingNotes().length, 1);
	assert.deepEqual(project.starting("writer1", null, undefined, 7), { starting: null, overlaps: [] });
	assert.deepEqual(project.startingNotes(), []);
	// The log loads back the same.
	project.starting("writer1", "Docs again", ["notes/todo.md"], 8);
	assert.deepEqual(
		Project.load(store.entries, new MemoryStore(), { now: () => 8 }).startingNotes(),
		project.startingNotes(),
	);
});

test("a note that names files by glob, or only in its text, brings news on a first edit (#37)", () => {
	const project = new Project(new MemoryStore());
	project.init(
		{
			"tools/play.mjs": "launch();\n",
			"tools/shot.mjs": "launch();\n",
			"tools/lib/args.mjs": "x;\n",
			"src/audio/audio.ts": "a;\n",
			"src/main.ts": "m;\n",
		},
		0,
	);
	for (const a of ["builder4", "builder6", "builder5"]) project.sync(a);
	// builder6's real note: the glob is only in the text.
	project.starting("builder6", "Add --mute-audio to every Chromium launch in tools/*.mjs", undefined, 1);
	const first = edit(
		project,
		"builder4",
		{ file: "tools/play.mjs", old: "launch();", new: "launch({ mute: true });" },
		2,
	);
	assert.deepEqual(first.news, [
		'builder6 says it is starting on tools/play.mjs ("Add --mute-audio to every Chromium launch in tools/*.mjs"), which you just started changing. If it\'s the same work, talk to builder6 before going further; abso where shows the lines.',
	]);
	// `*` stays in its folder.
	assert.deepEqual(edit(project, "builder4", { file: "tools/lib/args.mjs", old: "x;", new: "y;" }, 3).news, []);
	// Globs in files, and a bare file name in the text, count too.
	project.starting("builder5", "Mute flag: one line in main.ts", ["src/audio/**"], 4);
	const n = project.record("builder4", { "src/audio/audio.ts": "b;\n", "src/main.ts": "n;\n" }, 5).news;
	assert.equal(n.length, 1);
	assert.match(
		n[0]!,
		/^builder5 says it is starting on src\/audio\/audio\.ts, src\/main\.ts \("Mute flag: one line in main\.ts"\)/,
	);
});

test("starting on a glob names the unpublished changes it covers, and their author hears of it", () => {
	const project = new Project(new MemoryStore());
	project.init({ "tools/play.mjs": "launch();\n", "tools/shot.mjs": "launch();\n", "src/x.ts": "x;\n" }, 0);
	for (const a of ["builder4", "builder6"]) project.sync(a);
	edit(project, "builder4", { file: "tools/play.mjs", old: "launch();", new: "launch(1);" }, 1);
	edit(project, "builder4", { file: "src/x.ts", old: "x;", new: "y;" }, 2);
	const a = project.starting("builder6", "Mute every launch", ["tools/*.mjs"], 3);
	assert.deepEqual(a.overlaps, [{ agent: "builder4", file: "tools/play.mjs", changes: 1 }]);
	assert.match(
		project.news("builder4").news[0]!,
		/^builder6 says it is starting on "Mute every launch", naming tools\/play\.mjs/,
	);
});

test("globs.ts: patterns, meeting patterns, and paths in a note's text", () => {
	assert.equal(matchesPattern("tools/*.mjs", "tools/play.mjs"), true);
	assert.equal(matchesPattern("tools/*.mjs", "tools/lib/a.mjs"), false);
	assert.equal(matchesPattern("tools/**/*.mjs", "tools/lib/a.mjs"), true);
	assert.equal(matchesPattern("tools/**/*.mjs", "tools/a.mjs"), true);
	assert.equal(matchesPattern("main.ts", "src/main.ts"), true);
	assert.equal(matchesPattern("main.ts", "src/domain.ts"), false);
	assert.equal(matchesPattern("src/main.ts", "main.ts"), false);
	assert.equal(patternsMeet("tools/*.mjs", "tools/play.mjs"), true);
	assert.equal(patternsMeet("tools/*.mjs", "tools/*.mjs"), true);
	assert.equal(patternsMeet("tools/*.mjs", "src/*.ts"), false);
	assert.deepEqual(pathsInText("Add --mute-audio to every Chromium launch in tools/*.mjs"), ["tools/*.mjs"]);
	assert.deepEqual(
		pathsInText(
			"Key rebinding: src/render/keys.ts (remap + Keys panel), one line each in main.ts keydown/keyup, audio.ts KeyM",
		),
		["audio.ts", "keydown/keyup", "main.ts", "src/render/keys.ts"],
	);
	assert.deepEqual(pathsInText("ice saws x1.3, sells 0.05 iron/s at 120; see https://example.com/a.ts."), ["iron/s"]);
});

test("starting checks its input", () => {
	const { project } = setup();
	assert.throws(() => project.starting("writer1", "  ", undefined, 1), /starting needs \{text\}/);
	assert.throws(() => project.starting("writer1", "x", ["../etc"], 1));
	assert.throws(() => project.starting("writer1", "x".repeat(1001), undefined, 1), /at most 1000/);
});
