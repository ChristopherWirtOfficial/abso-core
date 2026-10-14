import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { SqlState } from "./storage-helper.ts";

test("many insertion runs reopen without fetching every run", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const files = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`file-${i}.txt`, `value ${i}`]));
	const atom = buildBase(files, { author: "fixture", message: "many files", time: 0 });
	new Graph({ storage }).add(atom);
	assert.ok(JSON.stringify(storage.read("atoms", "0")).length < 2048);
	const read = storage.read.bind(storage);
	let runs = 0;
	storage.read = (collection, key) => {
		if (collection === "atom-inserts:0") runs++;
		return read(collection, key);
	};
	const saved = new Graph({ storage }).atom("a0");
	assert.equal(saved.inserts.length, atom.inserts.length);
	assert.equal(runs, 0);
	assert.deepEqual([...saved.inserts[256]!.lines], atom.inserts[256]!.lines);
	assert.equal(runs, 1);
});
