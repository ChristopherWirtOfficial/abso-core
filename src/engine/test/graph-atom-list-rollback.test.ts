import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("partial atom-list persistence rolls back and retries on the same graph", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		const keys = Array.from({ length: 257 }, () => lineKey("a0.0"));
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "lists",
			time: 1,
			inserts: [],
			deletes: [],
			writes: keys,
			reads: [],
			holds: [],
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a0"],
		};
		const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		const write = storage.write.bind(storage);
		storage.write = (collection, key, value) => {
			write(collection, key, value);
			if (collection === "atom-list:1:writes" && key === "128") throw Error("injected list persistence failure");
		};
		assert.throws(() => graph.add(atom), /injected list persistence failure/);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		assert.equal(graph.size, 1);
		storage.write = write;
		graph.add(atom);
		assert.deepEqual([...new Graph({ storage }).atom("a1").writes], keys);
	} finally {
		storage.db.close();
	}
});
