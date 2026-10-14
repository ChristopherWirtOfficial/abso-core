import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import { storedLists } from "../state-source.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("persistent key indexes deduplicate repeated keys without per-atom key sets", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		const keys = Array.from({ length: 513 }, () => lineKey("a0.0"));
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "keys",
			time: 1,
			inserts: [],
			deletes: [],
			writes: keys,
			reads: keys,
			holds: keys,
			needs: [],
			resolves: ["a0", "a0"],
			reasons: [],
			deps: ["a0"],
		};
		graph.add(atom);
		for (const collection of ["writers", "readers", "holders", "resolvers"]) {
			const index = storedLists<string>(storage, collection, (key) => key);
			let matches = 0;
			for (const key of index.keys()) {
				const values = [...index.values(key)];
				const count = values.filter((value) => value === "a1").length;
				assert.ok(count <= 1);
				matches += count;
			}
			assert.equal(matches, 1, collection);
		}
	} finally {
		storage.db.close();
	}
});

test("last list entry reads only its final page and rejects truncated pages", () => {
	const storage = new SqlState();
	try {
		const list = storedLists<number>(storage, "items");
		for (let i = 0; i < 513; i++) list.append("key", i);
		const read = storage.read.bind(storage);
		storage.read = (collection, key) => {
			if (collection === "items:pages") assert.equal(key, JSON.stringify(["key", 2]));
			return read(collection, key);
		};
		assert.equal(list.last("key"), 512);
		storage.write("items:pages", JSON.stringify(["key", 2]), [512, 513]);
		assert.throws(() => list.last("key"), /incomplete writer list page/);
	} finally {
		storage.db.close();
	}
});
