import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("persistent atom validation uses rollback scratch for memberships", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "next",
			time: 1,
			inserts: [],
			deletes: [],
			writes: [],
			reads: [],
			holds: [],
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a0"],
		};
		const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		assert.throws(() => graph.add({ ...atom, deps: ["a0", "a0"] }), /listed twice/);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		let scratchWrites = 0;
		const write = storage.write.bind(storage);
		storage.write = (collection, key, value) => {
			if (collection.startsWith("projection-scratch:") && collection.endsWith(":deps")) scratchWrites++;
			write(collection, key, value);
		};
		graph.add(atom);
		assert.ok(scratchWrites > 0);
		assert.equal(
			storage.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection LIKE 'projection-scratch:%'").get()!.n,
			0,
		);
		assert.equal(new Graph({ storage }).size, 2);
	} finally {
		storage.db.close();
	}
});
