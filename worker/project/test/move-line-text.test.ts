import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../../../src/engine/graph.ts";
import { StoredText } from "../../../src/engine/stored-text.ts";
import { Repo } from "../../../src/engine/test/helpers.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MoveLineText } from "../move-line-text.ts";

test("move text symbols compare stored chunks exactly and distinguish hash collisions", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const long = "x".repeat(100000);
	const repo = Repo.init({ f: `reqicjpk\nejfslztg\n${long}\n${long}\n  {};\n` });
	const graph = new Graph({ storage });
	graph.add(repo.graph.atom("a0"));
	t.mock.method(StoredText.prototype, "read", () => {
		throw Error("whole text forbidden");
	});
	const texts = new MoveLineText(graph);
	assert.notEqual(texts.intern("a0.0"), texts.intern("a0.1"));
	assert.equal(texts.intern("a0.2"), texts.intern("a0.3"));
	assert.equal(texts.plain[texts.intern("a0.2")], false);
	assert.equal(texts.plain[texts.intern("a0.4")], true);
	const known = texts.intern("a0.2");
	t.mock.method(graph, "textChunks", () => {
		throw Error("known identity must not reread text");
	});
	assert.equal(texts.intern("a0.2"), known);
});
