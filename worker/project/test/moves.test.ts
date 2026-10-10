// Moves in drafts (#28): within one agent's unpublished draft, a line that
// leaves one place and the same text that arrives somewhere else is the same
// line. Publishing records it as a move, so someone else's edit to those
// lines follows them instead of colliding.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const AREA = "export function area(r: number) {\n  const pi = 3.14;\n  return pi * r * r;\n}\n";
const START = {
	"src/shapes.ts": `// shapes\n${AREA}\nexport function other() {\n  return 1;\n}\n`,
	"src/geometry.ts": "// geometry\n",
};
const SHAPES_AFTER = "// shapes\n\nexport function other() {\n  return 1;\n}\n";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	project.sync("ann");
	project.sync("bob");
	return { project, store };
}

/** ann moves area() to geometry.ts the way an agent's tools do: delete it, then write it. */
function annMovesArea(project: Project, order: "delete first" | "write first" = "delete first"): void {
	const del = () => project.edit("ann", { file: "src/shapes.ts", old: AREA, new: "" }, 1);
	const write = () => project.edit("ann", { file: "src/geometry.ts", content: `// geometry\n${AREA}` }, 1);
	if (order === "delete first") {
		del();
		write();
	} else {
		write();
		del();
	}
}

for (const order of ["delete first", "write first"] as const) {
	test(`a function moved to another file (${order}) while someone else edits it: the edit follows it`, () => {
		const { project } = setup();
		project.edit("bob", { file: "src/shapes.ts", old: "3.14", new: "Math.PI" }, 1);
		assert.equal(project.publish("bob", "Use Math.PI", 2).ok, true);
		annMovesArea(project, order);
		const published = project.publish("ann", "Move area to geometry", 3);
		assert.equal(published.ok, true, JSON.stringify(published));
		const files = project.files();
		assert.equal(files["src/shapes.ts"], SHAPES_AFTER);
		assert.equal(files["src/geometry.ts"], `// geometry\n${AREA.replace("3.14", "Math.PI")}`);
		// ann's folder gets bob's edit at the function's new place.
		assert.deepEqual(project.sync("ann").files, { "src/geometry.ts": files["src/geometry.ts"] });
	});
}

test("an edit pushed after the move, made against the old place, lands at the new one", () => {
	const { project } = setup();
	annMovesArea(project);
	project.edit("bob", { file: "src/shapes.ts", old: "const pi = 3.14;", new: "const pi = 3.1416;" }, 1);
	assert.equal(project.publish("ann", "Move area", 2).ok, true);
	// bob hears that the lines it changed moved, with its change.
	const news = project.edit("bob", { file: "src/shapes.ts", old: "return 1;", new: "return 1; // other" }, 2);
	assert.deepEqual(news.ok && news.news, [
		'ann pushed "Move area" (version 1), which moved lines your draft changes from src/shapes.ts to src/geometry.ts; your changes moved with them. Run abso pull to see them there.',
	]);
	project.restore("bob", null, 2);
	project.edit("bob", { file: "src/shapes.ts", old: "return pi * r * r;", new: "return pi * r ** 2;" }, 3);
	assert.equal(project.publish("bob", "Square", 4).ok, true);
	assert.equal(project.files()["src/geometry.ts"], `// geometry\n${AREA.replace("r * r", "r ** 2")}`);
	assert.equal(project.files()["src/shapes.ts"], SHAPES_AFTER);
});

test("a file renamed with record, while someone edits it", () => {
	const { project } = setup();
	project.edit("bob", { file: "src/shapes.ts", old: "return 1;", new: "return 2;" }, 1);
	assert.equal(project.publish("bob", "Two", 2).ok, true);
	project.record("ann", { "src/shapes.ts": null, "src/figures.ts": START["src/shapes.ts"] }, 3);
	assert.equal(project.publish("ann", "Rename shapes to figures", 4).ok, true);
	const files = project.files();
	assert.equal("src/shapes.ts" in files, false);
	assert.equal(files["src/figures.ts"], START["src/shapes.ts"].replace("return 1;", "return 2;"));
});

test("pushing a move leaves the mover's own files exactly as they were", () => {
	const { project } = setup();
	annMovesArea(project);
	project.edit("ann", { file: "src/geometry.ts", old: "3.14", new: "3.14159" }, 2);
	const before = project.diff("ann").files.map((f) => [f.path, f.after]);
	assert.equal(project.publish("ann", "Move and refine area", 3).ok, true);
	assert.deepEqual(project.sync("ann").files, {});
	const files = project.files();
	for (const [path, after] of before) assert.equal(files[path!], after);
});

test("a split: part of a file moves to a new one while someone edits both parts", () => {
	const { project } = setup();
	project.edit("bob", { file: "src/shapes.ts", old: "3.14", new: "Math.PI" }, 1);
	project.edit("bob", { file: "src/shapes.ts", old: "return 1;", new: "return 2;" }, 1);
	assert.equal(project.publish("bob", "Both parts", 2).ok, true);
	project.record(
		"ann",
		{ "src/shapes.ts": `// shapes\n${AREA}`, "src/other.ts": "\nexport function other() {\n  return 1;\n}\n" },
		3,
	);
	assert.equal(project.publish("ann", "Split other out", 4).ok, true);
	const files = project.files();
	assert.equal(files["src/shapes.ts"], `// shapes\n${AREA.replace("3.14", "Math.PI")}`);
	assert.equal(files["src/other.ts"], "\nexport function other() {\n  return 2;\n}\n");
});

test("lines too plain to identify do not count as moved on their own", () => {
	const { project } = setup();
	// A closing bracket deleted in one place and another written elsewhere.
	project.record(
		"ann",
		{
			"src/geometry.ts": "// geometry\n}\n",
			"src/shapes.ts": START["src/shapes.ts"].replace("  return 1;\n}\n", "  return 1;\n"),
		},
		1,
	);
	assert.equal(project.publish("ann", "Brackets", 2).ok, true);
	assert.equal(
		project.graph.atoms().some((a) => a.moves !== undefined),
		false,
	);
});

test("a plain-git commit that renames a file keeps its lines, so an agent's edit follows", () => {
	const { project } = setup();
	project.edit("bob", { file: "src/shapes.ts", old: "return 1;", new: "return 3;" }, 1);
	const files = { "src/figures.ts": START["src/shapes.ts"], "src/geometry.ts": START["src/geometry.ts"] };
	const answer = project.ingest(
		{ author: "pat", base: 0, commits: [{ sha: "abcdef1234", message: "Rename", files }] },
		2,
	);
	assert.equal(answer.landed, true);
	assert.equal(project.publish("bob", "Three", 3).ok, true);
	assert.equal(project.files()["src/figures.ts"], START["src/shapes.ts"].replace("return 1;", "return 3;"));
	assert.equal("src/shapes.ts" in project.files(), false);
});

test("a log with moves loads back to the same state", () => {
	const { project, store } = setup();
	annMovesArea(project);
	project.publish("ann", "Move area", 2);
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.files(), project.files());
});

test("a file's log lists an edit to lines moved into it, though the lines were written elsewhere (#43)", () => {
	const { project } = setup();
	annMovesArea(project);
	project.publish("ann", "Move area to geometry", 2);
	project.sync("bob");
	// Taking a line out names only the file it was written in, shapes.ts.
	project.edit("bob", { file: "src/geometry.ts", old: "  const pi = 3.14;\n", new: "" }, 3);
	project.publish("bob", "No pi line", 4);
	assert.deepEqual(
		project.log({ path: "src/geometry.ts" }).versions.map((v) => v.message),
		["No pi line", "Move area to geometry", "Start the project"],
	);
	assert.deepEqual(
		project.log({ path: "src/shapes.ts" }).versions.map((v) => v.message),
		["Move area to geometry", "Start the project"],
	);
});

// Where moves stop today (#62, step 2, proposal C would change the first). Pinned so a change is a choice.
test("a function re-indented on its way to another file is not a move: someone's edit to it collides", () => {
	const { project } = setup();
	project.edit("bob", { file: "src/shapes.ts", old: "3.14", new: "Math.PI" }, 1);
	project.edit("ann", { file: "src/shapes.ts", old: AREA, new: "" }, 1);
	const indented = AREA.split("\n")
		.map((l) => (l === "" ? l : `\t${l}`))
		.join("\n");
	project.edit("ann", { file: "src/geometry.ts", content: `// geometry\nexport namespace G {\n${indented}}\n` }, 1);
	assert.equal(project.publish("ann", "Move area into a namespace", 2).ok, true);
	const bob = project.publish("bob", "Use Math.PI", 3);
	assert.equal(bob.ok, false, "the lines bob edited are gone, not moved");
});

test("a move split across two pushes is a delete and a fresh write: the moved lines are new", () => {
	const { project } = setup();
	project.edit("ann", { file: "src/shapes.ts", old: AREA, new: "" }, 1);
	assert.equal(project.publish("ann", "Take area out", 2).ok, true);
	project.edit("ann", { file: "src/geometry.ts", content: `// geometry\n${AREA}` }, 3);
	assert.equal(project.publish("ann", "Put area back, elsewhere", 4).ok, true);
	const lines = project.sharedView().lines("src/geometry.ts");
	assert.equal(project.publishOf(lines[1]!.atom)?.version, 2, "written fresh in version 2, not carried from version 0");
});

test("past the move limit only the longest blocks move: a rewrite of many single lines still pushes, and a block moved whole keeps someone's edit (abso issue 137)", () => {
	const keys = Array.from({ length: 200 }, (_, i) => `  "k${i}": ${i},`);
	const block = ["  // block", '  "b1": "one",', '  "b2": "two",', '  "b3": "three",', "  // end block"];
	const before = `${["{", ...block, ...keys, "}"].join("\n")}\n`;
	// The draft reverses the keys with a new line between each, so every one is its own one-line match.
	const rewritten = keys.toReversed().flatMap((k, i) => [k, `  "n${i}": 0,`]);
	const after = `${["{", ...rewritten, ...block, "}"].join("\n")}\n`;
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "f.json": before }, 0);
	project.sync("ann");
	project.sync("bob");
	project.edit("bob", { file: "f.json", old: '"two"', new: '"TWO"' }, 1);
	assert.equal(project.publish("bob", "two is TWO", 2).ok, true);
	project.edit("ann", { file: "f.json", content: after }, 3);
	const published = project.publish("ann", "Rewrite f.json", 4);
	assert.equal(published.ok, true, JSON.stringify(published));
	assert.equal(project.files()["f.json"], after.replace('"two"', '"TWO"'));
});
