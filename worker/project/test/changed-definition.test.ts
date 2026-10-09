// The changed-definition rule (#11): publishing is refused when the draft's
// new lines use a name whose definition changed in work published after the
// agent's base. Git merges these without a word.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const START = {
	"src/parse.ts": [
		"export function parsePattern(text: string): Node {",
		'  return { kind: "lit", text };',
		"}",
		"",
		"export interface Node {",
		"  kind: string;",
		"  text: string;",
		"}",
	].join("\n"),
	"src/match.ts": [
		'import { parsePattern } from "./parse.ts";',
		"",
		"export function run(p: string) {",
		"  return p;",
		"}",
	].join("\n"),
	"README.md": "Uses parsePattern.\n",
};

function setup() {
	const project = new Project(new MemoryStore());
	project.init(START, 0);
	project.sync("lib");
	project.sync("user");
	return project;
}

/** user adds a call to parsePattern in match.ts. */
function userCalls(project: Project) {
	project.edit(
		"user",
		{ file: "src/match.ts", old: "  return p;\n", new: "  const tree = parsePattern(p);\n  return tree;\n" },
		1,
	);
}

test("a signature change published first refuses a draft that calls it", () => {
	const project = setup();
	userCalls(project);
	project.edit(
		"lib",
		{
			file: "src/parse.ts",
			old: "parsePattern(text: string): Node",
			new: "parsePattern(text: string, flags: string): Node",
		},
		2,
	);
	assert.equal(project.publish("lib", "parsePattern takes flags", 3).ok, true);

	const refused = project.publish("user", "run parses", 4);
	assert.equal(refused.ok, false);
	assert.deepEqual(!refused.ok && refused.collisions, [
		{
			kind: "definition",
			name: "parsePattern",
			file: "src/match.ts",
			yours: { lines: [4, 4], text: "  const tree = parsePattern(p);\n" },
			theirs: {
				file: "src/parse.ts",
				lines: [1, 1],
				text: "export function parsePattern(text: string, flags: string): Node {\n",
				agent: "lib",
				message: "parsePattern takes flags",
				version: 1,
			},
		},
	]);

	// After a sync the agent has seen the new definition, so publishing goes through.
	project.sync("user");
	assert.equal(project.publish("user", "run parses", 5).ok, true);
});

test("the drafting agent hears about it with its next edit", () => {
	const project = setup();
	userCalls(project);
	project.edit(
		"lib",
		{ file: "src/parse.ts", old: "parsePattern(text: string)", new: "parsePattern(source: string)" },
		2,
	);
	project.publish("lib", "Rename the parameter", 3);
	const answer = project.edit("user", { file: "src/match.ts", old: "return tree;", new: "return tree ;" }, 4);
	assert.deepEqual(answer.ok && answer.news, [
		'lib published "Rename the parameter" (version 1), which changes the definition of parsePattern (src/parse.ts line 1), ' +
			"and your draft uses parsePattern in src/match.ts line 4; run abso sync to see the new definition.",
	]);
	assert.deepEqual(project.edit("user", { file: "src/match.ts", old: "return tree ;", new: "return tree;" }, 5), {
		ok: true,
		news: [],
	});
});

test("a body edit, or a change to a name the draft does not use, goes through", () => {
	const project = setup();
	userCalls(project);
	project.edit(
		"lib",
		{ file: "src/parse.ts", old: '  return { kind: "lit", text };', new: '  return { kind: "literal", text };' },
		2,
	);
	project.publish("lib", "Body only", 3);
	assert.equal(project.publish("user", "run parses", 4).ok, true);
});

test("a type whose shape changed refuses a draft that uses it", () => {
	const project = setup();
	project.edit(
		"user",
		{ file: "src/match.ts", old: "import { parsePattern }", new: "import { parsePattern, Node }" },
		1,
	);
	project.edit(
		"user",
		{
			file: "src/match.ts",
			old: "export function run(p: string) {",
			new: "export function run(p: string, n?: Node) {",
		},
		1,
	);
	project.edit(
		"lib",
		{ file: "src/parse.ts", old: "  text: string;\n}", new: "  text: string;\n  kids: Node[];\n}" },
		2,
	);
	project.publish("lib", "Nodes have kids", 3);
	const refused = project.publish("user", "run takes a node", 4);
	assert.equal(refused.ok, false);
	assert.equal(!refused.ok && refused.collisions[0]!.name, "Node");
});

test("a definition that disappears refuses a draft that uses the name", () => {
	const project = setup();
	userCalls(project);
	project.edit("lib", { file: "src/parse.ts", old: "function parsePattern(", new: "function parseRegex(" }, 2);
	project.publish("lib", "Rename parsePattern to parseRegex", 3);
	const refused = project.publish("user", "run parses", 4);
	assert.equal(refused.ok, false);
	const c = !refused.ok ? refused.collisions[0]! : undefined;
	assert.equal(c?.kind, "definition");
	assert.equal(c?.name, "parsePattern");
	assert.equal(c?.theirs.text, "");
});

test("a name the draft defines itself is its own, and prose doesn't count", () => {
	const project = setup();
	project.edit(
		"user",
		{
			file: "src/match.ts",
			old: "  return p;\n",
			new: "  const parsePattern = (x: string) => x;\n  return parsePattern(p);\n",
		},
		1,
	);
	project.edit("user", { file: "README.md", content: "Uses parsePattern a lot.\n" }, 1);
	project.edit("lib", { file: "src/parse.ts", old: "parsePattern(text: string)", new: "parsePattern(t: string)" }, 2);
	project.publish("lib", "Shorter name", 3);
	assert.equal(project.publish("user", "Local helper", 4).ok, true);
});

test("my own published change to a definition never refuses my next publish", () => {
	const project = setup();
	project.edit(
		"lib",
		{ file: "src/parse.ts", old: "parsePattern(text: string)", new: 'parsePattern(text: string, flags = "")' },
		1,
	);
	project.publish("lib", "flags", 2);
	project.edit("lib", { file: "src/match.ts", old: "  return p;\n", new: '  return parsePattern(p, "g");\n' }, 3);
	assert.equal(project.publish("lib", "use flags", 4).ok, true);
});

test("an import says which definition a use means", () => {
	const project = new Project(new MemoryStore());
	project.init(
		{
			"src/a/util.ts": "export function shapeOf(x: string) {\n  return x;\n}\n",
			"src/b/util.ts": "export function shapeOf(x: number) {\n  return x;\n}\n",
			"src/main.ts": 'import { shapeOf } from "./a/util.ts";\n\nexport const top = 1;\n',
		},
		0,
	);
	project.sync("lib");
	project.sync("user");
	project.edit(
		"user",
		{ file: "src/main.ts", old: "export const top = 1;", new: 'export const top = shapeOf("1");' },
		1,
	);
	// A change to the other file's shapeOf doesn't touch the one main.ts imports.
	project.edit("lib", { file: "src/b/util.ts", old: "shapeOf(x: number)", new: "shapeOf(x: bigint)" }, 2);
	project.publish("lib", "b takes bigint", 3);
	assert.equal(project.publish("user", "top uses shapeOf", 4).ok, true);
	// A change to the imported one does.
	project.edit("user", { file: "src/main.ts", old: 'shapeOf("1")', new: 'shapeOf("2")' }, 5);
	project.edit("lib", { file: "src/a/util.ts", old: "shapeOf(x: string)", new: "shapeOf(x: string, y: string)" }, 6);
	project.publish("lib", "a takes two", 7);
	const refused = project.publish("user", "two", 8);
	assert.equal(refused.ok, false);
	assert.equal(!refused.ok && refused.collisions[0]!.theirs.file, "src/a/util.ts");
});

test("Python imports scope a use too", () => {
	const project = new Project(new MemoryStore());
	project.init(
		{
			"pkg/one.py": "def build_tree(x):\n    return x\n",
			"pkg/two.py": "def build_tree(x):\n    return x\n",
			"app.py": "from pkg.one import build_tree\n\nresult = 1\n",
		},
		0,
	);
	project.sync("lib");
	project.sync("user");
	project.edit("user", { file: "app.py", old: "result = 1", new: "result = build_tree(1)" }, 1);
	project.edit("lib", { file: "pkg/two.py", old: "def build_tree(x):", new: "def build_tree(x, y):" }, 2);
	project.publish("lib", "two takes y", 3);
	assert.equal(project.publish("user", "use it", 4).ok, true);
});

test("a local name, a parameter or a property that shares a name with another file's definition is not a use of it", () => {
	// From the regex trial (#25): news fired on a fuzzer's own caps and body
	// against other files' definitions of the same names.
	const project = new Project(new MemoryStore());
	project.init({ "meta.ts": "export const caps = 1;\n", "fuzz.ts": "export function go() {\n  return 0;\n}\n" }, 0);
	project.sync("fuzzer");
	project.sync("meta");
	project.edit(
		"fuzzer",
		{
			file: "fuzz.ts",
			old: "  return 0;",
			new: "  const r = { caps: 2 };\n  return r.caps + run(r);\n}\nfunction run(caps: object) {\n  return caps ? 1 : 0;",
		},
		1,
	);
	project.edit("meta", { file: "meta.ts", old: "caps = 1", new: "caps = 2" }, 2);
	project.publish("meta", "More caps", 3);
	assert.equal(project.publish("fuzzer", "Fuzz with caps", 4).ok, true);

	// A local inside another file's function is not a definition either.
	project.sync("fuzzer");
	project.sync("meta");
	project.record("meta", { "parse.ts": "export function parse() {\n  const body = 1;\n  return body;\n}\n" }, 5);
	project.publish("meta", "Parser", 6);
	project.sync("fuzzer");
	project.sync("meta");
	project.edit(
		"fuzzer",
		{ file: "fuzz.ts", old: "  return caps ? 1 : 0;", new: "  const body = caps;\n  return body ? 1 : 0;" },
		7,
	);
	project.edit("meta", { file: "parse.ts", old: "const body = 1;", new: "const body = 2;" }, 8);
	project.publish("meta", "Other body", 9);
	assert.equal(project.publish("fuzzer", "Fuzz with a body", 10).ok, true);

	// A use through an import still means the definition, and is refused when it changed.
	project.sync("fuzzer");
	project.sync("meta");
	project.record("fuzzer", { "use.ts": 'import { caps } from "./meta.ts";\nexport const twice = caps * 2;\n' }, 11);
	project.edit("meta", { file: "meta.ts", old: "caps = 2", new: "caps = 3" }, 12);
	project.publish("meta", "Even more caps", 13);
	const refused = project.publish("fuzzer", "Use caps", 14);
	assert.equal(!refused.ok && refused.collisions[0]!.name, "caps");
});

test("only names the change added count: editing a line that already used the name is not a use (#25)", () => {
	const project = new Project(new MemoryStore());
	project.init(
		{
			"lib.ts": "export function measure(s: string) {\n  return s.length;\n}\n",
			"use.ts": 'import { measure } from "./lib.ts";\nexport const a = measure("ab");\nexport const b = 1;\n',
		},
		0,
	);
	project.sync("lib");
	project.sync("app");
	// app edits a line that already used measure (a different argument), and adds an unrelated line.
	project.edit("app", { file: "use.ts", old: 'measure("ab")', new: 'measure("abc")' }, 1);
	project.edit("app", { file: "use.ts", old: "export const b = 1;", new: "export const b = 2;" }, 1);
	project.edit("lib", { file: "lib.ts", old: "measure(s: string)", new: "measure(s: string, trim = false)" }, 2);
	project.publish("lib", "measure can trim", 3);
	const edited = project.edit("app", { file: "use.ts", old: "b = 2", new: "b = 3" }, 4);
	assert.deepEqual(edited.ok && edited.news, []);
	assert.equal(project.publish("app", "Longer string", 5).ok, true);

	// A use the change adds still counts.
	project.sync("app");
	project.sync("lib");
	project.edit("app", { file: "use.ts", old: "export const b = 3;", new: 'export const b = measure("x");' }, 6);
	project.edit("lib", { file: "lib.ts", old: "trim = false", new: "trim = true" }, 7);
	project.publish("lib", "Trim by default", 8);
	const refused = project.publish("app", "b from measure", 9);
	assert.equal(!refused.ok && refused.collisions[0]!.name, "measure");
});
