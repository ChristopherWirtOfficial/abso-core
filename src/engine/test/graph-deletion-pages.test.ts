import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom, LineId } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("persistent delete counts do not load the atom's deleted-line payload", () => {
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
		graph.add(atom);
		const reopened = new Graph({ storage });
		const read = storage.read.bind(storage);
		storage.read = (collection, key) => {
			assert.notEqual(collection, "atom-deletes", "count decoded the full deletion list");
			assert.notEqual(collection, "atom-deletes:pages", "count read deletion payload pages");
			return read(collection, key);
		};
		assert.equal(reopened.deleteCount("a1"), 300);
		storage.read = read;
		assert.deepEqual(reopened.deletedLines("a1"), deletes);
	} finally {
		storage.db.close();
	}
});
