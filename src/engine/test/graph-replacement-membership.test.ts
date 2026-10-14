import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("replacement membership distinguishes first, repeated and previous deletions", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		const oracle = new Graph();
		const base = buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 });
		graph.add(base);
		oracle.add(base);
		for (let seq = 1; seq <= 3; seq++) {
			const deleting = seq < 3;
			const atom: Atom = {
				id: `a${seq}`,
				seq,
				author: "fixture",
				message: "replacement",
				time: seq,
				inserts: [{ file: "a.txt", parent: "a0.0", lines: [`new ${seq}`] }],
				deletes: deleting ? ["a0.0"] : [],
				writes: deleting ? [lineKey("a0.0")] : [],
				reads: [],
				holds: [],
				needs: [],
				resolves: [],
				reasons: [],
				deps: [`a${seq - 1}`],
			};
			graph.add(atom);
			oracle.add(atom);
			assert.equal(graph.replaces(`a${seq}.0`), deleting);
			assert.equal(new Graph({ storage }).replaces(`a${seq}.0`), oracle.replaces(`a${seq}.0`));
		}
	} finally {
		storage.db.close();
	}
});
