// The atoms whose reasons point at an atom (abso Capacity, Graph.reasonsTo): why's "reasons in" reads them instead of
// every atom. In seq order, once each, whatever the kind and however many reasons one atom gives; kept from a fresh
// stored graph on, and undefined on a stored graph made before, where the caller looks at every atom.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../index.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

function history() {
	const repo = Repo.init({ "f.txt": lines("one", "two", "three") });
	const x = repo.edit({ author: "ann", message: "x", edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
	repo.edit({
		author: "bob",
		message: "y",
		edits: [{ file: "f.txt", old: "two", new: "TWO" }],
		reasons: [
			{ to: x.id, kind: "together", text: "same idea" },
			{ to: x.id, kind: "because-of", text: "and because of it" },
		],
	});
	repo.edit({ author: "cy", message: "unrelated", edits: [{ file: "f.txt", old: "three", new: "3" }] });
	repo.edit({
		author: "dee",
		message: "z",
		edits: [{ file: "f.txt", old: "3", new: "THREE" }],
		reasons: [{ to: x.id, kind: "supersedes", text: "replaces it" }],
	});
	return { repo, x };
}

/** Every atom whose reasons point at id, by looking at each one: what reasonsTo must give. */
const scanned = (graph: Graph, id: string) =>
	[...graph.atoms()].filter((a) => a.reasons.some((r) => r.to === id)).map((a) => a.id);

test("reasonsTo lists the atoms pointing at an atom, in seq order, once each", () => {
	const { repo, x } = history();
	const want = scanned(repo.graph, x.id);
	assert.equal(want.length, 2, "bob's two reasons and dee's");
	assert.deepEqual(repo.graph.reasonsTo(x.id), want);
	const storage = new SqlState();
	const stored = new Graph({ storage });
	for (const atom of repo.graph.atoms()) stored.add(atom);
	assert.deepEqual(new Graph({ storage }).reasonsTo(x.id), want);
	assert.deepEqual(new Graph({ storage }).reasonsTo("a0"), []);
});

test("a stored graph made before the index keeps none, and says so", () => {
	const { repo, x } = history();
	const storage = new SqlState();
	const stored = new Graph({ storage });
	for (const atom of repo.graph.atoms()) stored.add(atom);
	storage.remove("reasons-in:meta", "kept");
	assert.equal(new Graph({ storage }).reasonsTo(x.id), undefined);
});
