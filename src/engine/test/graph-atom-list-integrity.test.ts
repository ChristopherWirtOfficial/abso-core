import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("stored atom list metadata refuses missing or substituted references", () => {
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

		const stored = storage.read("atoms", "1") as Record<string, unknown>;
		for (const lists of [undefined, {}, { writes: "atom-list:1:reads" }]) {
			storage.write("atoms", "1", { ...stored, lists });
			assert.throws(() => new Graph({ storage }).atom("a1"), /stored atom list/);
		}
	} finally {
		storage.db.close();
	}
});
