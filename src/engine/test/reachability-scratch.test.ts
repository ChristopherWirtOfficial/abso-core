import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { CachedStateStorage } from "../state-source.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

test("persistent reachability uses rollback scratch across deep shared ancestry and graph append", () => {
	const source = new SqlState();
	try {
		const storage = new CachedStateStorage(source, 8192, 32);
		const graph = new Graph({ storage });
		const oracle = new Graph();
		const add = (atom: Atom) => {
			graph.add(atom);
			oracle.add(atom);
		};
		add(buildBase({ "a.txt": "base\n" }, { author: "fixture", message: "base", time: 0 }));
		for (let seq = 1; seq <= 513; seq++)
			add({
				id: `a${seq}`,
				seq,
				author: "fixture",
				message: "branch",
				time: seq,
				inserts: seq === 1 ? [{ file: "b.txt", parent: "^b.txt", lines: ["other"] }] : [],
				deletes: [],
				writes: [],
				reads: [],
				holds: [],
				needs: [],
				resolves: [],
				reasons: [],
				deps: seq === 1 ? [] : seq === 2 ? ["a1"] : [`a${seq - 1}`, `a${seq - 2}`],
			});
		const before = source.db.prepare("SELECT * FROM state ORDER BY collection, key").all();
		for (const target of ["a0", "a1", "a127", "a512", "a513"]) {
			assert.equal(graph.dependsOn("a513", target), oracle.dependsOn("a513", target));
			assert.deepEqual(source.db.prepare("SELECT * FROM state ORDER BY collection, key").all(), before);
		}
		const atom: Atom = {
			id: "a514",
			seq: 514,
			author: "fixture",
			message: "append through ancestor",
			time: 514,
			inserts: [{ file: "b.txt", parent: "a1.0", lines: ["next"] }],
			deletes: [],
			writes: [],
			reads: [],
			holds: [],
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a513"],
		};
		source.failWrite = source.writes + 3;
		assert.throws(() => graph.add(atom), /injected storage failure/);
		assert.deepEqual(source.db.prepare("SELECT * FROM state ORDER BY collection, key").all(), before);
		source.failWrite = Infinity;
		const reopened = new Graph({ storage: new CachedStateStorage(source) });
		assert.throws(
			() => reopened.add({ ...atom, inserts: [{ file: "a.txt", parent: "a0.0", lines: ["invalid"] }] }),
			/not in its closure/,
		);
		assert.deepEqual(source.db.prepare("SELECT * FROM state ORDER BY collection, key").all(), before);
		reopened.add(atom);
		oracle.add(atom);
		assert.equal(reopened.lineCount, oracle.lineCount);
		assert.equal(reopened.size, oracle.size);
		assert.equal(reopened.dependsOn("a514", "a1"), true);
		assert.equal(
			source.db.prepare("SELECT count(*) AS n FROM state WHERE collection LIKE 'projection-scratch:%'").get()!.n,
			0,
		);
	} finally {
		source.db.close();
	}
});
