import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("large persisted atom lists stay out of metadata and read incrementally", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		const keys = Array.from({ length: 513 }, () => lineKey("a0.0"));
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "lists",
			time: 1,
			inserts: [],
			deletes: [],
			writes: keys,
			reads: keys,
			holds: keys,
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a0"],
		};
		graph.add(atom);
		assert.ok(JSON.stringify(storage.read("atoms", "1")).length < 2048);
		let items = 0;
		const read = storage.read.bind(storage);
		storage.read = (collection, key) => {
			if (collection.startsWith("atom-list:") && !collection.endsWith(":meta")) items++;
			return read(collection, key);
		};
		const saved = new Graph({ storage }).atom("a1");
		assert.equal(items, 0);
		assert.equal(saved.writes.length, 513);
		assert.equal(items, 0);
		assert.equal(saved.writes[512], keys[512]);
		assert.equal(items, 1);
		assert.throws(() => {
			(saved.writes as string[])[0] = "changed";
		}, /read-only/);
		assert.deepEqual([...saved.writes], keys);
	} finally {
		storage.db.close();
	}
});
