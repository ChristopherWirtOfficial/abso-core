import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom, LineId } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("deletion page failure rolls back acceptance and missing pages fail after reopen", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(
			buildBase(
				{ "a.txt": Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") },
				{ author: "fixture", message: "base", time: 0 },
			),
		);
		const deletes = Array.from({ length: 300 }, (_, i) => `a0.${i}` as LineId);
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "delete",
			time: 1,
			inserts: [],
			deletes,
			writes: deletes.map(lineKey),
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
			if (collection === "atom-deletes:pages" && key === JSON.stringify(["1", 1]))
				throw Error("injected deletion page failure");
		};
		assert.throws(() => graph.add(atom), /injected deletion page failure/);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		assert.equal(graph.size, 1);
		storage.write = write;
		graph.add(atom);
		assert.equal(new Graph({ storage }).deleteCount("a1"), 300);
		assert.deepEqual(new Graph({ storage }).deletedLines("a1"), deletes);
		storage.remove("atom-deletes:pages", JSON.stringify(["1", 1]));
		assert.throws(() => new Graph({ storage }).deletedLines("a1"), /missing or invalid writer list page/);
	} finally {
		storage.db.close();
	}
});
