import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAtom } from "../build.ts";
import { Graph } from "../graph.ts";
import { StoredText } from "../stored-text.ts";
import { diffChunkedLines } from "../text.ts";
import { View } from "../view.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("stored line comparison and atom construction never assemble historical long text", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const line = "x".repeat(100000) + "\ud800\udc00";
	const repo = Repo.init({ "f.txt": `${line}\nkeep\n` });
	const graph = new Graph({ storage });
	graph.add(repo.graph.atom("a0"));
	t.mock.method(StoredText.prototype, "read", () => {
		throw Error("whole stored text forbidden");
	});
	t.mock.method(graph, "textOf", () => {
		throw Error("whole line forbidden");
	});
	const chunks = [...graph.textChunks(0)];
	assert.equal(chunks.join(""), line);
	assert.ok(chunks.every((chunk) => chunk.length <= StoredText.chunkCharacters));
	const view = new View(graph, ["a0"]);
	assert.deepEqual(diffChunkedLines(view.lineChunks("f.txt"), [line, "changed"]), [
		{ start: 1, end: 2, lines: ["changed"] },
	]);
	assert.equal(
		buildAtom(view, {
			author: "writer",
			message: "change",
			edits: [{ file: "f.txt", start: 0, end: 1, lines: ["replacement"] }],
		}).deletes.length,
		1,
	);
	assert.throws(() => [...graph.textChunks(-1)], /invalid line/);
	assert.throws(() => [...graph.textChunks(2)], /invalid line/);
});
