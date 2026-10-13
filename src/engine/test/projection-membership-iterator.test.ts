import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionLocator } from "../experimental/projection-locator.ts";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { ProjectionReader } from "../experimental/projection-reader.ts";
import { Graph } from "../graph.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("locator streams ordered immutable leaves with bounded first-result reads", () => {
	const db = new SqlState();
	try {
		const index = new ProjectionLocator(db, "iterate", (v) => {
			if (typeof v !== "number") throw Error("invalid value");
			return v;
		});
		let root: number | null = null;
		for (let id = 511; id >= 0; id--) root = index.set(root, id, id);
		const previous = root;
		root = index.set(root, 256, -1);
		const before = db.reads;
		const iterator = index.entries(root);
		assert.deepEqual(iterator.next().value, [0, 0]);
		assert.ok(db.reads - before <= 9);
		iterator.return?.();
		assert.deepEqual(
			[...index.entries(previous)],
			Array.from({ length: 512 }, (_, id) => [id, id]),
		);
		assert.equal([...index.entries(root)][256]?.[1], -1);
		db.write('experimental-locator:"iterate"', String(root), {
			format: 1,
			kind: "branch",
			prefix: "",
			children: { 0: root, 1: root },
		});
		assert.throws(() => index.entries(root).next(), /invalid locator child/);
	} finally {
		db.db.close();
	}
});

test("projected membership streams without atom payload reads and expires with its scope", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\n" });
		const atoms = [repo.graph.atom("a0"), repo.edit({ edits: [{ file: "a.txt", old: "one\n", new: "two\n" }] })];
		const graph = new Graph({ storage: db });
		for (const atom of atoms) graph.add(atom);
		const adapter = new ExperimentalMarkerProjection(db, graph, "a.txt", "membership");
		let state = adapter.empty();
		for (const atom of atoms) state = adapter.apply(state, atom);
		let live = true;
		const reader = new ProjectionReader(adapter, state, () => {
			if (!live) throw Error("expired");
		});
		const read = db.read.bind(db);
		db.read = (collection, key) => {
			if (collection === "atoms") throw Error("atom payload read forbidden");
			return read(collection, key);
		};
		assert.deepEqual([...reader.set], ["a0", "a1"]);
		assert.equal(reader.set.has("a1"), true);
		const iterator = reader.set.values();
		assert.equal(iterator.next().value, "a0");
		live = false;
		assert.throws(() => iterator.next(), /expired/);
	} finally {
		db.db.close();
	}
});
