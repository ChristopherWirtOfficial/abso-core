import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../graph.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("indexed identities and metadata do not decode atom payloads", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\n" });
		const graph = new Graph({ storage: db });
		graph.add(repo.graph.atom("a0"));
		const read = db.read.bind(db);
		db.read = (collection, key) => {
			if (collection === "atoms") throw Error("atom payload read forbidden");
			return read(collection, key);
		};
		assert.equal(graph.idOfSeq(0), "a0");
		assert.equal(graph.lamport("a0"), 0);
		assert.deepEqual(graph.filesOf("a0"), ["a.txt"]);
		assert.equal(graph.line("a0.0")?.atom, "a0");
		assert.equal(graph.lineIdOf(0), "a0.0");
		for (const seq of [-1, 1, 0.5, NaN, Infinity]) assert.throws(() => graph.idOfSeq(seq), /no atom/);
		for (const id of ["a1", "a00", "a-1", "invalid"]) {
			assert.throws(() => graph.lamport(id), /no atom/);
			assert.throws(() => graph.filesOf(id), /no atom/);
		}
		assert.equal(graph.line("a1.0"), undefined);
		assert.throws(() => graph.atom("a0"), /payload read forbidden/);
	} finally {
		db.db.close();
	}
});
