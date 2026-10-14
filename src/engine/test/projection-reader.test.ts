import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAtom } from "../build.ts";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { ProjectionReadScope } from "../experimental/projection-read-scope.ts";
import { ProjectionReader } from "../experimental/projection-reader.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";

import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("projected text streams lines and line lookup does not read file text", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const text = `${"x".repeat(40000)}\nsecond\nthird\n`;
	const repo = Repo.init({ "f.txt": text, "empty.txt": "" });
	const graph = new Graph({ storage: new CachedStateStorage(storage) });
	graph.add(repo.graph.atom("a0"));
	const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "streamed-text");
	const state = adapter.apply(adapter.empty(), graph.atom("a0"));
	const reader = new ProjectionReader(adapter, state, () => {});
	t.mock.method(reader, "lines", () => {
		throw Error("full line array forbidden");
	});
	assert.equal(reader.text("f.txt"), text);
	assert.equal(reader.text("empty.txt"), "");
	assert.equal(reader.text("missing.txt"), "");
	const ids = [...adapter.lineIds(state, "f.txt")];
	t.mock.method(graph, "textOf", () => {
		throw Error("line lookup must not read text");
	});
	for (let i = 0; i < ids.length; i++) assert.equal(reader.lineNumber("f.txt", ids[i]!), i);
	assert.equal(reader.lineNumber("f.txt", "missing"), -1);
});

test("unchanged atom builder consumes the private reader for replacement and insertion edits", () => {
	const storage = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "one\ntwo\nthree\n" });
		const graph = new Graph({ storage: new CachedStateStorage(storage) });
		graph.add(repo.graph.atom("a0"));
		const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "builder-reader");
		let state = adapter.apply(adapter.empty(), graph.atom("a0"));
		for (let i = 0; i < 16; i++) {
			const input = {
				author: "writer",
				message: `Edit ${i}`,
				time: i,
				edits: [
					{
						file: "f.txt",
						old: repo.view().text("f.txt"),
						new: `one\nrevision ${i}\nthree\n${i % 2 ? "extra\n" : ""}`,
					},
				],
			};
			const expected = buildAtom(repo.view(), input);
			const reader = new ProjectionReader(adapter, state, new ProjectionReadScope(graph, () => graph).guard(graph));
			const actual = buildAtom(reader, input);
			assert.deepEqual(actual, expected);
			graph.add(actual);
			repo.graph.add(expected);
			repo.shared.add(expected.id);
			state = adapter.apply(state, actual);
			assert.equal(
				new ProjectionReader(adapter, state, new ProjectionReadScope(graph, () => graph).guard(graph)).text("f.txt"),
				repo.view().text("f.txt"),
			);
		}
	} finally {
		storage.db.close();
	}
});

test("private reader builds cross-file moves and resurrects a deleted file", (t) => {
	const storage = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "one\ntwo\nthree\n", "g.txt": "other\n" });
		const graph = new Graph({ storage: new CachedStateStorage(storage) });
		graph.add(repo.graph.atom("a0"));
		const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "reader-moves");
		let state = adapter.apply(adapter.empty(), graph.atom("a0"));
		const inputs: Parameters<typeof buildAtom>[1][] = [
			{ author: "writer", message: "Move", move: { file: "f.txt", start: 1, end: 2, to: "g.txt", at: 1 } },
			{ author: "writer", message: "Delete file", edits: [{ file: "f.txt", old: "one\nthree\n", new: "" }] },
			{ author: "writer", message: "Recreate file", edits: [{ file: "f.txt", old: "", new: "reborn\n" }] },
			{ author: "writer", message: "Move back", move: { file: "g.txt", start: 1, end: 2, to: "f.txt", at: 0 } },
		];
		for (const input of inputs) {
			const expected = buildAtom(repo.view(), input),
				reader = new ProjectionReader(adapter, state, new ProjectionReadScope(graph, () => graph).guard(graph));
			const actual = buildAtom(reader, input);
			assert.deepEqual(actual, expected);
			graph.add(actual);
			repo.graph.add(expected);
			repo.shared.add(expected.id);
			state = adapter.apply(state, actual);
			const projected = new ProjectionReader(adapter, state, new ProjectionReadScope(graph, () => graph).guard(graph));
			t.mock.method(projected, "parentOf", () => {
				throw Error("line ancestry traversal forbidden");
			});
			for (const path of ["f.txt", "g.txt"]) {
				assert.deepEqual(projected.sequence(path), repo.view().sequence(path));
				for (const line of projected.sequence(path))
					assert.equal(projected.fileOf(line.id), repo.view().fileOf(line.id));
			}
		}
	} finally {
		storage.db.close();
	}
});

test("reader orders deletion contributors by Lamport before sequence and treats unknown membership as absent", () => {
	const storage = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "target\n", "g.txt": "other\n" });
		const chain = repo.edit({ edits: [{ file: "g.txt", old: "other", new: "changed" }] });
		const high = repo.edit({ edits: [{ file: "f.txt", old: "target\n", new: "" }], needs: [chain.id] });
		const low = repo.edit({ edits: [{ file: "f.txt", old: "target\n", new: "" }] }, ["a0"]);
		assert.ok(repo.graph.lamportOfSeq(high.seq) > repo.graph.lamportOfSeq(low.seq));
		assert.ok(high.seq < low.seq);
		const graph = new Graph({ storage: new CachedStateStorage(storage) });
		const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "reader-priority");
		let state = adapter.empty();
		for (const id of ["a0", chain.id, high.id, low.id]) {
			const atom = repo.graph.atom(id);
			graph.add(atom);
			state = adapter.apply(state, atom);
		}
		const reader = new ProjectionReader(adapter, state, new ProjectionReadScope(graph, () => graph).guard(graph));
		assert.deepEqual(reader.sequence("f.txt"), repo.view().sequence("f.txt"));
		assert.equal(reader.set.has("unknown-atom"), false);
	} finally {
		storage.db.close();
	}
});
