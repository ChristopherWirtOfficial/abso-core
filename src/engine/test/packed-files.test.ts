// Each file's line history packed (abso Capacity, Graph.packedLines): a stored graph lays files out from a few pages,
// and must give exactly what the in-memory graph gives, through edits, deletes, moves between files and back.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph, View } from "../index.ts";
import { StableOverlaySet } from "../state-source.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("a packed file lays out as the in-memory graph does, at every step, moves included", () => {
	const oracle = Repo.init({ "a.txt": lines("one", "two", "three", "four"), "b.txt": lines("bee"), "c.txt": "" });
	const sets: Set<string>[] = [new Set(oracle.shared)];
	const step = (change: Parameters<Repo["edit"]>[0]) => {
		oracle.edit(change);
		sets.push(new Set(oracle.shared));
	};
	step({ edits: [{ file: "a.txt", old: "two", new: "TWO" }] });
	step({ move: { file: "a.txt", start: 1, end: 3, to: "b.txt", at: 1 } });
	step({ edits: [{ file: "b.txt", old: "TWO", new: "two again" }] });
	step({ edits: [{ file: "a.txt", old: "four", new: "" }] });
	step({ move: { file: "b.txt", start: 0, end: 2, to: "c.txt", at: 0 } });
	step({ edits: [{ file: "c.txt", old: "bee", new: "bee\nafter bee" }] });
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		for (const atom of oracle.graph.atoms()) graph.add(atom);
		const reopened = new Graph({ storage });
		assert.equal(reopened.packedFiles, true);
		for (const [i, set] of sets.entries()) {
			const packed = new View(reopened, new StableOverlaySet(set));
			const memory = new View(oracle.graph, set);
			assert.deepEqual(packed.paths(), memory.paths(), `step ${i}: paths`);
			for (const path of ["a.txt", "b.txt", "c.txt"]) {
				assert.equal(packed.text(path), memory.text(path), `step ${i}: ${path}`);
				assert.deepEqual(packed.sequence(path), memory.sequence(path), `step ${i}: ${path}'s sequence`);
				assert.deepEqual(packed.attrs(path), memory.attrs(path), `step ${i}: ${path}'s attributes`);
			}
		}
	} finally {
		storage.db.close();
	}
});

test("a graph made with packFiles off keeps no packed history", () => {
	const oracle = Repo.init({ "a.txt": lines("one") });
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage, packFiles: false });
		for (const atom of oracle.graph.atoms()) graph.add(atom);
		assert.equal(new Graph({ storage }).packedFiles, false);
		assert.equal(new View(new Graph({ storage }), new StableOverlaySet(oracle.shared)).text("a.txt"), "one\n");
	} finally {
		storage.db.close();
	}
});
