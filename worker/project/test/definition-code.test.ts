import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph, View } from "../../../src/engine/index.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { withDefinitionCode } from "../definition-code.ts";
import { definedTwice, definitionsIn } from "../definitions.ts";
import { codeOfLines } from "../names.ts";

test("small parsed code stays in memory without scratch writes", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const graph = new Graph({ storage });
	graph.add(buildBase({ "f.ts": "export const answer = 42;\n" }, { author: "writer", message: "init" }));
	const view = new View(graph, ["a0"]);
	const writes = storage.writes;
	withDefinitionCode(view, view.buildLines("f.ts"), (code) => {
		assert.deepEqual(code, codeOfLines(["export const answer = 42;"]));
	});
	assert.equal(storage.writes, writes);
});

test("disk definition code preserves random reads and always rolls scratch back", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const lines = [
		"/* comment",
		"end */ export function parseOne(",
		"arg: string",
		") { return 1; }",
		...Array.from({ length: 4000 }, (_, i) => `const value${i} = ${i}; // trailing`),
	];
	const atom = buildBase({ "f.ts": `${lines.join("\n")}\n` }, { author: "writer", message: "init" });
	const memory = new Graph();
	memory.add(atom);
	const graph = new Graph({ storage });
	graph.add(atom);
	const view = new View(graph, ["a0"]);
	const expected = codeOfLines(lines);
	const rows = () => storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	const before = rows();
	let escaped: readonly string[] = [];
	withDefinitionCode(view, view.buildLines("f.ts"), (code) => {
		escaped = code;
		assert.deepEqual(code.slice(0, 4), expected.slice(0, 4));
		for (let i = code.length - 1; i >= 0; i--) assert.equal(code[i], expected[i]);
		for (let i = 0; i < code.length; i++) assert.equal(code[i], expected[i]);
	});
	assert.throws(() => escaped[0], /scope has ended/);
	assert.deepEqual(rows(), before);
	assert.deepEqual(definitionsIn(view), definitionsIn(new View(memory, ["a0"])));
	assert.deepEqual(definedTwice(view, "f.ts"), definedTwice(new View(memory, ["a0"]), "f.ts"));
	assert.deepEqual(rows(), before);
	storage.failWrite = storage.writes + 2;
	assert.throws(() => withDefinitionCode(view, view.buildLines("f.ts"), () => []), /injected storage failure/);
	assert.deepEqual(rows(), before);
});
