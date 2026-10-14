import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { gapKey, posKey } from "../keys.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("move validation uses indexed write membership without rescanning the write list", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "one\ntwo" }, { author: "fixture", message: "base", time: 0 }));
		const writes = [posKey("a0.1"), gapKey("a0.0")];
		writes.includes = () => {
			throw Error("whole write list scan forbidden");
		};
		const atom: Atom = {
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "move",
			time: 1,
			inserts: [],
			deletes: [],
			writes,
			reads: [],
			holds: [],
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a0"],
			moves: [{ line: "a0.1", parent: "a0.0" }],
		};
		graph.add(atom);
		assert.equal(new Graph({ storage }).size, 2);
		assert.throws(() => graph.add({ ...atom, id: "a2", seq: 2, writes: [posKey("a0.1")] }), /without writing/);
		assert.equal(graph.size, 2);
	} finally {
		storage.db.close();
	}
});
