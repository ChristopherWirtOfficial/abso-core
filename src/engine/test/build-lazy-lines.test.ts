import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAtom } from "../build.ts";
import { Repo } from "./helpers.ts";

test("splice atom construction reads only the replaced region's text", (t) => {
	const repo = Repo.init({ "f.txt": `${"unrelated".repeat(10000)}\nold\nlast\n` });
	const view = repo.view();
	const input = { author: "writer", message: "replace", edits: [{ file: "f.txt", start: 1, end: 2, lines: ["new"] }] };
	const expected = buildAtom(view, input);
	const original = repo.graph.textChunks.bind(repo.graph);
	const reads: number[] = [];
	t.mock.method(repo.graph, "textChunks", (n: number) => {
		reads.push(n);
		assert.equal(n, 1);
		return original(n);
	});
	assert.deepEqual(buildAtom(repo.view(), input), expected);
	assert.deepEqual(reads, [1]);
	reads.length = 0;
	buildAtom(repo.view(), {
		author: "writer",
		message: "insert",
		edits: [{ file: "f.txt", start: 1, end: 1, lines: ["added"] }],
	});
	assert.deepEqual(reads, []);
});

test("many splice edits build line handles only once per file", (t) => {
	const repo = Repo.init({ "f.txt": Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join("") });
	const view = repo.view();
	const read = view.buildLines.bind(view);
	let calls = 0;
	t.mock.method(view, "buildLines", (path: string) => {
		calls++;
		return read(path);
	});
	const edits = Array.from({ length: 400 }, (_, i) => ({
		file: "f.txt",
		start: i * 4,
		end: i * 4 + 1,
		lines: [`new ${i}`],
	}));
	assert.equal(buildAtom(view, { author: "writer", message: "many edits", edits }).deletes.length, 400);
	assert.equal(calls, 1);
});
