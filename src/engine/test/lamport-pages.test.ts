// A stored graph's lamport numbers (abso Capacity, Graph.#lamportPages): a fresh graph keeps them 256 to a row, and a
// graph that already keeps them a row each goes on doing so. Both answer every atom's lamport as the in-memory graph.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../index.ts";
import { storedArray } from "../state-source.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

function history() {
	const oracle = Repo.init({ "a.txt": lines("one", "two", "three"), "b.txt": "" });
	oracle.edit({ edits: [{ file: "a.txt", old: "two", new: "TWO" }] });
	oracle.edit({ move: { file: "a.txt", start: 1, end: 2, to: "b.txt", at: 0 } });
	oracle.edit({ edits: [{ file: "a.txt", old: "three", new: "three\nfour" }] });
	return oracle;
}

test("a fresh stored graph keeps lamport numbers in pages and reopens with them", () => {
	const oracle = history();
	const storage = new SqlState();
	const original = new Graph({ storage });
	for (const atom of oracle.graph.atoms()) original.add(atom);
	assert.equal(storage.read("lamport:meta", "length"), undefined, "no row each");
	assert.equal(storage.read("lamport-pages:meta", "length"), oracle.graph.size);
	const reopened = new Graph({ storage });
	for (const atom of oracle.graph.atoms()) assert.equal(reopened.lamport(atom.id), oracle.graph.lamport(atom.id));
	assert.deepEqual([...reopened.movers()], [...oracle.graph.movers()]);
});

test("a graph that keeps lamport numbers a row each goes on reading and writing rows", () => {
	const oracle = history();
	const atoms = [...oracle.graph.atoms()];
	const storage = new SqlState();
	const original = new Graph({ storage });
	for (const atom of atoms.slice(0, -1)) original.add(atom);
	// As a graph adopted before pages: the same numbers a row each, and no pages.
	const rows = storedArray<number>(storage, "lamport");
	for (let seq = 0; seq < atoms.length - 1; seq++) rows.push(original.lamportOfSeq(seq));
	storage.remove("lamport-pages:meta", "length");
	storage.remove("lamport-pages:meta", "format");
	const reopened = new Graph({ storage });
	for (const atom of atoms.slice(0, -1)) assert.equal(reopened.lamport(atom.id), oracle.graph.lamport(atom.id));
	reopened.add(atoms.at(-1)!);
	assert.equal(storage.read("lamport:meta", "length"), atoms.length, "the new atom gets a row");
	assert.equal(reopened.lamport(atoms.at(-1)!.id), oracle.graph.lamport(atoms.at(-1)!.id));
	assert.equal(storage.read("lamport-pages:meta", "length"), undefined);
});
