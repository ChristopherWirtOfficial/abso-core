// Merging at sync (#25, from the regex trial): when an agent's draft and work
// published since its base change the same lines, a sync merges the file the
// way git does. Changes both made identically are kept once; real
// differences stay a collision. A name both sides define in one file is a
// collision of its own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const BASE = [
	"// classset",
	"export function parse(h: string, h2: string) {",
	"  if (!/^[0-9a-f]{2}$/i.test(h)) err('Invalid escape');",
	"  if (!/^[0-9a-f]+$/i.test(h)) err('Invalid Unicode escape');",
	"  return h2;",
	"}",
	"function err(m: string): never {",
	"  throw new SyntaxError(m);",
	"}",
	"",
].join("\n");
const CALLS = BASE.replace("!/^[0-9a-f]{2}$/i.test(h)", "!isHex(h, 2)").replace(
	"!/^[0-9a-f]+$/i.test(h)",
	"!isHex(h, -1)",
);
const HELPER =
	"function isHex(s: string, len: number): boolean {\n  return /* no RegExp */ s.length > 0 && (len < 0 || s.length === len);\n}\n";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "engine/classset.ts": BASE }, 0);
	project.sync("prefix");
	project.sync("fuzzer");
	return { project, store };
}

test("the same edit on both sides merges into one copy at sync: no collision, no doubled lines", () => {
	const { project } = setup();
	project.record("prefix", { "engine/classset.ts": CALLS + HELPER }, 1);
	assert.equal(project.publish("prefix", "isHex instead of regex literals", 2).ok, true);
	project.record("fuzzer", { "engine/classset.ts": CALLS + HELPER }, 3);
	const s = project.sync("fuzzer");
	assert.deepEqual(s.collisions, []);
	assert.equal(project.draftOf("fuzzer")!.view.text("engine/classset.ts"), CALLS + HELPER);
	assert.equal(project.publish("fuzzer", "Nothing left of mine", 4).ok, true);
	assert.equal(project.files()["engine/classset.ts"], CALLS + HELPER);
});

test("Fuzzer's case: identical call lines merge once; the two helpers are a duplicate collision until one goes", () => {
	const { project } = setup();
	// prefix: the calls, and its helper at the bottom.
	project.record("prefix", { "engine/classset.ts": CALLS + HELPER }, 1);
	assert.equal(project.publish("prefix", "isHex instead of regex literals", 2).ok, true);
	// fuzzer, unpublished: the same calls, and its own helper at the top.
	const mine = CALLS.replace("// classset\n", "// classset\n" + HELPER.replace("no RegExp", "hex only"));
	project.record("fuzzer", { "engine/classset.ts": mine }, 3);
	const s = project.sync("fuzzer");
	const text = project.draftOf("fuzzer")!.view.text("engine/classset.ts");
	assert.equal(text.split("\n").filter((l) => l.includes("err('Invalid escape')")).length, 1);
	assert.equal(text.split("\n").filter((l) => l.startsWith("function isHex")).length, 2);
	assert.deepEqual(
		s.collisions.map((c) => [c.kind, c.name, c.file, c.theirs.agent]),
		[["duplicate", "isHex", "engine/classset.ts", "prefix"]],
	);
	const refused = project.publish("fuzzer", "Helper", 4);
	assert.deepEqual(!refused.ok && refused.collisions.map((c) => c.kind), ["duplicate"]);
	// fuzzer keeps prefix's helper; now it publishes.
	project.record("fuzzer", { "engine/classset.ts": CALLS + HELPER }, 5);
	assert.equal(project.publish("fuzzer", "Keep one isHex", 6).ok, true);
});

test("different edits to the same lines still collide, with both sides in the file", () => {
	const { project } = setup();
	project.edit("prefix", { file: "engine/classset.ts", old: "return h2;", new: "return h2.trim();" }, 1);
	project.publish("prefix", "Trim", 2);
	project.edit("fuzzer", { file: "engine/classset.ts", old: "return h2;", new: "return h2.toLowerCase();" }, 3);
	const s = project.sync("fuzzer");
	assert.deepEqual(
		s.collisions.map((c) => c.kind),
		["lines"],
	);
	const text = project.draftOf("fuzzer")!.view.text("engine/classset.ts");
	assert.ok(text.includes("h2.trim()") && text.includes("h2.toLowerCase()"));
});

test("a merge keeps the draft's other changes, and a log with a merge loads back the same", () => {
	const { project, store } = setup();
	project.record("prefix", { "engine/classset.ts": CALLS }, 1);
	project.publish("prefix", "Calls", 2);
	// fuzzer: the same calls, plus its own change elsewhere in the file.
	project.record(
		"fuzzer",
		{ "engine/classset.ts": CALLS.replace("throw new SyntaxError(m);", "throw new SyntaxError(`regex: ${m}`);") },
		3,
	);
	assert.deepEqual(project.sync("fuzzer").collisions, []);
	assert.equal(project.publish("fuzzer", "Prefix errors", 4).ok, true);
	assert.equal(
		project.files()["engine/classset.ts"],
		CALLS.replace("throw new SyntaxError(m);", "throw new SyntaxError(`regex: ${m}`);"),
	);
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).files(), project.files());
});

test("a duplicate shows each whole definition, body and all, and counts common names too", () => {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "p.ts": "// parser\n" }, 0);
	project.sync("alice");
	project.sync("bob");
	project.record("alice", { "p.ts": "// parser\nexport function parse() {\n  return 1;\n}\n" }, 1);
	project.publish("alice", "parse", 2);
	project.record("bob", { "p.ts": "// parser\nexport function parse() {\n  return 2;\n}\n" }, 3);
	const s = project.sync("bob");
	// Both inserted at the same place, so the lines collide too, with markers (#11); the duplicate is listed beside them.
	assert.deepEqual(
		s.collisions.map((c) => [c.kind, c.marked]),
		[
			["duplicate", undefined],
			["lines", true],
		],
	);
	const d = s.collisions[0]!;
	assert.equal(d.name, "parse");
	assert.equal(d.yours.text, "export function parse() {\n  return 2;\n}\n");
	assert.equal(d.theirs.text, "export function parse() {\n  return 1;\n}\n");
	assert.equal(d.yours.lines[1] - d.yours.lines[0], 2);
	assert.equal(d.theirs.lines[1] - d.theirs.lines[0], 2);
});

test("loop variables and functions passed as arguments are not top-level definitions (#37, Builder 4)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "tools/play.mjs": "// play\n" }, 0);
	project.sync("b4");
	project.record(
		"b4",
		{ "tools/play.mjs": "// play\nfor (let i = 0; i < 3; i++) step();\nrun(function helper() {});\n" },
		1,
	);
	assert.equal(project.publish("b4", "One loop", 2).ok, true);
	project.record(
		"b4",
		{
			"tools/play.mjs":
				"// play\nfor (let i = 0; i < 3; i++) step();\nrun(function helper() {});\nfor (let i = 0; i < 9; i++) beam();\nrun(function helper() {});\n",
		},
		3,
	);
	assert.equal(project.publish("b4", "Another loop", 4).ok, true);
	// A real top-level redeclaration against earlier work still is one.
	project.record("b4", { "tools/play.mjs": "export let speed = 1;\n" }, 5);
	project.publish("b4", "Speed", 6);
	project.record("b4", { "tools/play.mjs": "export let speed = 1;\nexport let speed = 2;\n" }, 7);
	const refused = project.publish("b4", "Speed again", 8);
	assert.deepEqual(!refused.ok && refused.collisions.map((c) => [c.kind, c.name]), [["duplicate", "speed"]]);
});

test("for, while and if at the start of a line name nothing (#37, Builder 4 again)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "tools/fjord.mjs": "// fjord\n" }, 0);
	project.sync("b4");
	project.record(
		"b4",
		{
			"tools/fjord.mjs":
				"// fjord\nfor (let i = 0; i < 3; i++) {\n  step(i);\n}\nwhile (busy()) {\n  wait();\n}\nif (ready()) {\n  go();\n}\n",
		},
		1,
	);
	assert.equal(project.publish("b4", "Loops", 2).ok, true);
	project.record(
		"b4",
		{
			"tools/fjord.mjs":
				"// fjord\nfor (let i = 0; i < 3; i++) {\n  step(i);\n}\nwhile (busy()) {\n  wait();\n}\nif (ready()) {\n  go();\n}\nfor (const [x, y] of [[720, 540]]) {\n  beam(x, y);\n}\nwhile (more()) {\n  drain();\n}\nif (done()) {\n  stop();\n}\n",
		},
		3,
	);
	assert.equal(project.publish("b4", "More loops", 4).ok, true);
});
