import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { SqlState } from "./storage-helper.ts";

test("persisted insertion lines stay out of atom metadata", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const text = Array.from({ length: 513 }, (_, i) => `line ${i}\n`).join("");
	const graph = new Graph({ storage });
	const atom = buildBase({ "a.txt": text }, { author: "fixture", message: "base", time: 0 });
	const oracle = new Graph();
	oracle.add(atom);
	graph.add(atom);
	const bytes = Buffer.byteLength(JSON.stringify(storage.read("atoms", "0")));
	assert.ok(bytes < 2048, `atom metadata retained ${bytes} bytes for 513 insertion lines`);
	assert.deepEqual([...new Graph({ storage }).atom("a0").inserts[0]!.lines], oracle.atom("a0").inserts[0]!.lines);
	const read = storage.read.bind(storage);
	let lineReads = 0;
	storage.read = (collection, key) => {
		if (collection === "atom-inserts:0:lines:0") lineReads++;
		return read(collection, key);
	};
	const saved = new Graph({ storage }).atom("a0");
	assert.equal(lineReads, 0);
	assert.equal(saved.inserts[0]!.lines.length, 513);
	assert.equal(lineReads, 0);
	assert.equal(saved.inserts[0]!.lines[512], oracle.atom("a0").inserts[0]!.lines[512]);
	assert.equal(lineReads, 1);
});

test("partial insertion persistence rolls back and retries on the same graph", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const graph = new Graph({ storage });
	const atom = buildBase(
		{ "a.txt": Array.from({ length: 513 }, (_, i) => `line ${i}\n`).join("") },
		{ author: "fixture", message: "base", time: 0 },
	);
	const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	const write = storage.write.bind(storage);
	storage.write = (collection, key, value) => {
		write(collection, key, value);
		if (collection === "atom-inserts:0:lines:0" && key === "128") throw Error("injected insertion failure");
	};
	assert.throws(() => graph.add(atom), /injected insertion failure/);
	assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
	assert.equal(graph.size, 0);
	storage.write = write;
	graph.add(atom);
	assert.deepEqual([...new Graph({ storage }).atom("a0").inserts[0]!.lines], atom.inserts[0]!.lines);
});
