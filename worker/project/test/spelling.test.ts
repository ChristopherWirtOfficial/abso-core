// One file whatever the case of its spelling (#49):
// a write under another spelling of an existing file is recorded as that
// file, with a warning; only a move changes a file's case. A move keeps the
// lines' ids, so blame follows the file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { blame } from "../blame.ts";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const project = new Project(new MemoryStore());
	project.init({ "README.md": "# readme\nline two\n", "src/a.ts": "export const a = 1;\n" }, 0);
	for (const a of ["ann", "bob"]) project.sync(a);
	return project;
}

test("a record or edit under another spelling goes to the existing file, with a warning", () => {
	const project = setup();
	const r = project.record("ann", { "readme.md": "# readme\nline two\nline three\n" }, 1);
	assert.deepEqual([r.changed, r.spelling], [["README.md"], [{ path: "readme.md", existing: "README.md" }]]);
	const e = project.edit("ann", { file: "SRC/A.TS", old: "1", new: "2" }, 2);
	assert.ok(e.ok && e.spelling);
	assert.deepEqual(e.ok && e.spelling, [{ path: "SRC/A.TS", existing: "src/a.ts" }]);
	project.publish("ann", "two edits", 3);
	assert.deepEqual(Object.keys(project.files()).sort(), ["README.md", "src/a.ts"], "still one file each");
	assert.equal(project.files()["README.md"], "# readme\nline two\nline three\n");
});

test("a move changes a file's case, and its lines keep their ids, so blame still names who wrote them", () => {
	const project = setup();
	project.edit("bob", { file: "README.md", old: "line two", new: "line 2" }, 1);
	project.publish("bob", "line 2", 2);
	project.sync("ann");
	const m = project.move("ann", "README.md", "readme.md", 3);
	assert.deepEqual([m.from, m.to], ["README.md", "readme.md"]);
	project.publish("ann", "lower case readme", 4);
	assert.deepEqual(Object.keys(project.files()).sort(), ["readme.md", "src/a.ts"]);
	assert.equal(project.files()["readme.md"], "# readme\nline 2\n");
	assert.deepEqual(
		blame(project, "readme.md").lines.map((l) => l.author),
		["init", "bob"],
	);
});

test("a move is refused onto another existing file, from a missing one, or to the same name", () => {
	const project = setup();
	assert.throws(() => project.move("ann", "src/a.ts", "Readme.MD", 1), /Readme\.MD is README\.md, another file/);
	assert.throws(() => project.move("ann", "nope.md", "x.md", 1), /there is no nope\.md to move/);
	assert.throws(() => project.move("ann", "README.md", "README.md", 1), /already called that/);
	const ok = project.move("ann", "src/a.ts", "lib/a.ts", 2);
	assert.equal(ok.to, "lib/a.ts");
});

test("a record naming both spellings, the old one gone, is a rename and is taken as it is", () => {
	const project = setup();
	const r = project.record("ann", { "README.md": null, "readme.md": "# readme\nline two\n" }, 1);
	assert.equal(r.spelling, undefined);
	project.publish("ann", "rename by record", 2);
	assert.deepEqual(Object.keys(project.files()).sort(), ["readme.md", "src/a.ts"]);
});

test("Unicode spellings of one name are one file, and a new decomposed name gets a gentle warning", () => {
	const project = setup();
	const composed = "notes/r\u00e9sum\u00e9.md";
	const decomposed = "notes/re\u0301sume\u0301.md";
	const first = project.record("ann", { [composed]: "one\n" }, 1);
	assert.equal(first.uncomposed, undefined);
	const second = project.record("ann", { [decomposed.toUpperCase()]: "two\n" }, 2);
	assert.deepEqual(second.spelling, [{ path: decomposed.toUpperCase(), existing: composed }]);
	project.publish("ann", "one name", 3);
	assert.deepEqual(
		Object.keys(project.files()).filter((p) => p.startsWith("notes/")),
		[composed],
	);
	const fresh = project.edit("ann", { file: "notes/cafe\u0301.md", content: "x\n" }, 4);
	assert.ok(fresh.ok);
	assert.deepEqual(fresh.ok && fresh.uncomposed, ["notes/cafe\u0301.md"]);
	assert.throws(() => project.move("ann", "src/a.ts", composed.toUpperCase(), 5), /another file/);
});

test("pathKey folds case and Unicode form, and ß as case folding does", async () => {
	const { pathKey } = await import("../pathkey.ts");
	assert.equal(pathKey("R\u00c9SUM\u00c9.md"), pathKey("re\u0301sume\u0301.md"));
	assert.equal(pathKey("Stra\u00dfe.txt"), pathKey("STRASSE.txt"));
	assert.notEqual(pathKey("a.md"), pathKey("b.md"));
});
