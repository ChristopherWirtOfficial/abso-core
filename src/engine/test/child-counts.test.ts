import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildCounts } from "../child-counts.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("child counts cross pages, reopen and roll back with the canonical transaction", () => {
	const source = new SqlState();
	try {
		const cache = new CachedStateStorage(source);
		const counts = new ChildCounts(cache);
		for (let n = 0; n < 513; n++) cache.transaction(() => counts.append(n));
		cache.transaction(() => counts.increment(255, 513));
		assert.equal(new ChildCounts(cache).at(255, 513), 1);
		assert.equal(counts.at(256, 513), 0);
		assert.throws(
			() =>
				cache.transaction(() => {
					counts.increment(255, 513);
					counts.append(513);
					throw new Error("rollback");
				}),
			/rollback/,
		);
		assert.equal(counts.at(255, 513), 1);
		assert.equal(counts.at(512, 513), 0);
		assert.equal(cache.retainedEntries > 0, true);
	} finally {
		source.db.close();
	}
});

test("child counts reject missing, relocated, truncated and inconsistent zero-count pages", () => {
	const source = new SqlState();
	try {
		const counts = new ChildCounts(source);
		counts.append(0);
		counts.append(1);
		counts.increment(0, 2);
		const original = source.read("ordered-child-counts", "0") as Record<string, unknown>;
		for (const changed of [
			{ ...original, counts: [0, 0] },
			{ ...original, counts: [1] },
			{ ...original, page: 1 },
			{ ...original, format: 2 },
			{ ...original, digest: "invalid" },
		]) {
			source.write("ordered-child-counts", "0", changed);
			assert.throws(() => counts.at(0, 2), /invalid ordered child count page/);
		}
		source.remove("ordered-child-counts", "0");
		assert.throws(() => counts.at(0, 2), /invalid ordered child count page/);
	} finally {
		source.db.close();
	}
});

test("graph rejects the previous ordered format and count corruption before empty-child shortcuts", () => {
	const source = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\n" });
		const graph = new Graph({ storage: source });
		graph.add(repo.graph.atom("a0"));
		assert.deepEqual([...graph.orderedChildrenN(0)], [1]);
		source.write("ordered-children", "format", 1);
		assert.throws(() => [...graph.orderedChildrenN(0)], /fresh adoption/);
		source.write("ordered-children", "format", 2);
		new ChildCounts(source).increment(0, 2);
		assert.throws(() => [...graph.orderedChildrenN(0)], /ordered child index count mismatch/);
		const page = source.read("ordered-child-counts", "0") as { counts: number[] };
		page.counts[0] = 0;
		source.write("ordered-child-counts", "0", page);
		assert.throws(() => [...graph.orderedChildrenN(0)], /invalid ordered child count page/);
	} finally {
		source.db.close();
	}
});
