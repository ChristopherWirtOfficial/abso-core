import assert from "node:assert/strict";
import { test } from "node:test";
import { CachedStateStorage } from "../state-source.ts";
import { SqlState } from "./storage-helper.ts";

test("numeric cache pages are detached on first and repeated reads, and rollback invalidates them", () => {
	const source = new SqlState();
	try {
		const cache = new CachedStateStorage(source, 4096, 4);
		cache.write("numbers", "page", [1, 2, 3]);
		(cache.read("numbers", "page") as number[])[0] = 99;
		assert.deepEqual(cache.read("numbers", "page"), [1, 2, 3]);
		(cache.read("numbers", "page") as number[]).push(4);
		assert.deepEqual(cache.read("numbers", "page"), [1, 2, 3]);
		assert.throws(
			() =>
				cache.transaction(() => {
					cache.write("numbers", "page", [8]);
					assert.deepEqual(cache.read("numbers", "page"), [8]);
					throw new Error("rollback numeric page");
				}),
			/rollback numeric page/,
		);
		assert.equal(cache.retainedBytes, 0);
		assert.deepEqual(cache.read("numbers", "page"), [1, 2, 3]);
		cache.remove("numbers", "page");
		assert.equal(cache.read("numbers", "page"), undefined);
	} finally {
		source.db.close();
	}
});

test("cached scalar metadata and bounded numeric pages need no JSON decode on hits", (t) => {
	const source = new SqlState();
	try {
		const cache = new CachedStateStorage(source, 8192, 8);
		const values = [undefined, null, true, "metadata", 42, Array.from({ length: 256 }, (_, n) => n)];
		for (let i = 0; i < values.length; i++) {
			cache.write("rows", String(i), values[i]);
			cache.read("rows", String(i));
		}
		const reads = source.reads;
		t.mock.method(JSON, "parse", () => {
			throw new Error("cache hit unexpectedly decoded JSON");
		});
		for (let i = 0; i < values.length; i++) assert.deepEqual(cache.read("rows", String(i)), values[i]);
		assert.equal(source.reads, reads);
		assert.ok(cache.retainedBytes <= 8192);
	} finally {
		source.db.close();
	}
});

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
