import assert from "node:assert/strict";
import { test } from "node:test";
import { CachedStateStorage } from "../state-source.ts";
import { SqlState } from "./storage-helper.ts";

test("bounded writer cache copies values, invalidates writes and clears after rollback", () => {
	const source = new SqlState();
	const cache = new CachedStateStorage(source, 1024, 3);
	source.write("rows", "a", { list: [1] });
	const first = cache.read("rows", "a") as { list: number[] };
	first.list.push(2);
	const reads = source.reads;
	assert.deepEqual(cache.read("rows", "a"), { list: [1] });
	assert.equal(source.reads, reads);
	cache.write("rows", "a", { list: [3] });
	assert.deepEqual(cache.read("rows", "a"), { list: [3] });
	assert.throws(
		() =>
			cache.transaction(() => {
				cache.write("rows", "a", { list: [4] });
				assert.deepEqual(cache.read("rows", "a"), { list: [4] });
				throw new Error("rollback");
			}),
		/rollback/,
	);
	assert.equal(cache.retainedEntries, 0);
	assert.deepEqual(cache.read("rows", "a"), { list: [3] });
	cache.remove("rows", "a");
	assert.equal(cache.read("rows", "a"), undefined);
	cache.write("rows", "a", "restored");
	assert.equal(cache.read("rows", "a"), "restored");
	source.db.close();
});

test("writer cache evicts by both payload and entry count and skips oversized values", () => {
	const source = new SqlState();
	const cache = new CachedStateStorage(source, 1024, 3);
	for (let i = 0; i < 100; i++) {
		cache.write("rows", String(i), "small");
		assert.equal(cache.read("rows", String(i)), "small");
		assert.ok(cache.retainedBytes <= 1024);
		assert.ok(cache.retainedEntries <= 3);
	}
	const reads = source.reads;
	cache.read("rows", "99");
	assert.equal(source.reads, reads);
	cache.read("rows", "0");
	assert.equal(source.reads, reads + 1);
	cache.write("rows", "large", "x".repeat(1024));
	const before = cache.retainedBytes;
	cache.read("rows", "large");
	assert.equal(cache.retainedBytes, before);
	const afterLarge = source.reads;
	cache.read("rows", "large");
	assert.equal(source.reads, afterLarge + 1);
	cache.clear();
	assert.equal(cache.retainedBytes, 0);
	source.db.close();
});
