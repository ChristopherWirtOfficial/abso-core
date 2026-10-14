import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionPriority } from "../experimental/projection-priority.ts";
import { orderedChildKey } from "../ordered-index.ts";
import { SqlState } from "./storage-helper.ts";

const decode = (value: unknown): number => {
	if (!Number.isSafeInteger(value)) throw Error("invalid payload");
	return value as number;
};
test("experimental priority retains old roots, removes winners and rejects corrupt pages", () => {
	const storage = new SqlState();
	try {
		const index = new ProjectionPriority(storage, "test", decode),
			oracle: { key: string; value: number }[] = [];
		let root: number | null = null;
		for (let n = 0; n < 96; n++) {
			const key = orderedChildKey({ n, replaces: n % 2, lamport: (n * 71) % 97, seq: n, k: 0 });
			const expected = oracle.filter((entry) => entry.key < key).at(-1)?.value;
			assert.equal(index.before(root, key), expected);
			const old: number | null = root;
			root = index.insert(root, key, n);
			assert.equal(index.before(old, key), expected);
			oracle.push({ key, value: n });
			oracle.sort((a, b) => a.key.localeCompare(b.key));
		}
		const full = root;
		const greatest = oracle.pop()!;
		root = index.remove(root, greatest.key);
		assert.equal(index.before(root, "f".repeat(57)), oracle.at(-1)!.value);
		assert.equal(index.before(full, "f".repeat(57)), greatest.value);
		const rows = () => JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows();
		storage.failWrite = storage.writes + 3;
		assert.throws(() => index.insert(root, "e".repeat(57), 100), /injected/);
		assert.equal(rows(), before);
		storage.failWrite = Infinity;
		const collection = 'experimental-priority:"test"',
			saved = storage.read(collection, String(root));
		for (const corrupt of [
			{ format: 1, kind: "branch", depth: 1, children: { "0": 0 } },
			{ format: 1, kind: "branch", depth: 0, children: { f: root } },
			{ format: 1, kind: "branch", depth: 0, children: {} },
		]) {
			storage.write(collection, String(root), corrupt);
			assert.throws(() => index.before(root, "f".repeat(57)), /invalid priority/);
		}
		storage.write(collection, String(root), saved);
		assert.equal(index.before(root, "f".repeat(57)), oracle.at(-1)!.value);
	} finally {
		storage.db.close();
	}
});

test("priority allocation rolls back a failed final counter and retries without collisions", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const index = new ProjectionPriority(storage, "counter-retry", decode);
	const key = "1".repeat(57);
	const root = index.insert(null, key, 1);
	const rows = () => storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	const before = rows();
	const original = storage.write.bind(storage);
	let fail = true;
	t.mock.method(storage, "write", (collection: string, key: string, value: unknown) => {
		original(collection, key, value);
		if (key === "next" && fail) throw Error("final allocation counter failure");
	});
	assert.throws(() => index.insert(root, "2".repeat(57), 2), /final allocation counter/);
	assert.deepEqual(rows(), before);
	assert.equal(index.before(root, "f".repeat(57)), 1);
	fail = false;
	const next = index.insert(root, "2".repeat(57), 2);
	assert.equal(index.before(next, "f".repeat(57)), 2);
	assert.equal(index.before(root, "f".repeat(57)), 1);
	const beforeRemove = rows();
	fail = true;
	assert.throws(() => index.remove(next, "2".repeat(57)), /final allocation counter/);
	assert.deepEqual(rows(), beforeRemove);
	fail = false;
	const removed = index.remove(next, "2".repeat(57));
	assert.equal(index.before(removed, "f".repeat(57)), 1);
});

test("compressed priority updates legacy depth paths without changing old roots", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const collection = 'experimental-priority:"legacy"';
	const key = "1".repeat(57);
	storage.write(collection, "57", { format: 1, kind: "leaf", depth: 57, value: 1 });
	for (let depth = 56; depth >= 0; depth--)
		storage.write(collection, String(depth), {
			format: 1,
			kind: "branch",
			depth,
			children: { [key[depth]!]: depth + 1 },
		});
	storage.write(collection, "next", 58);
	const index = new ProjectionPriority(storage, "legacy", decode);
	assert.equal(index.before(0, "f".repeat(57)), 1);
	const mixed = index.insert(0, "1".repeat(56) + "2", 2);
	assert.equal(index.before(mixed, "f".repeat(57)), 2);
	assert.equal(index.before(mixed, "1".repeat(56) + "2"), 1);
	assert.equal(index.before(0, "f".repeat(57)), 1);
	const removed = index.remove(mixed, key);
	assert.equal(index.before(removed, "f".repeat(57)), 2);
	assert.equal(index.remove(removed, "1".repeat(56) + "2"), null);
	assert.equal(index.before(0, "f".repeat(57)), 1);
});

test("compressed priority matches a sorted oracle across varied prefixes and removals", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const index = new ProjectionPriority(storage, "varied", decode);
	const oracle = new Map<string, number>();
	let root: number | null = null;
	let seed = 731;
	const randomKey = () =>
		Array.from({ length: 57 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return (seed >>> 28).toString(16);
		}).join("");
	const keys = [
		"0".repeat(57),
		"f".repeat(57),
		...Array.from({ length: 128 }, randomKey),
		...Array.from({ length: 32 }, (_, n) => "a".repeat(55) + n.toString(16).padStart(2, "0")),
	];
	const verify = () => {
		const sorted = [...oracle.keys()].sort();
		for (const key of [...keys, randomKey()]) {
			const before = sorted.filter((candidate) => candidate < key).at(-1);
			assert.equal(index.before(root, key), before === undefined ? undefined : oracle.get(before));
		}
	};
	for (const [n, key] of keys.entries()) {
		root = index.insert(root, key, n);
		oracle.set(key, n);
		if (n % 23 === 0) verify();
	}
	verify();
	for (const [n, key] of keys.entries()) {
		root = index.remove(root, key);
		oracle.delete(key);
		if (n % 19 === 0) verify();
	}
	assert.equal(root, null);
	verify();
});

test("compressed priority rejects malformed prefixes and cyclic child edges", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const collection = 'experimental-priority:"corrupt"';
	const index = new ProjectionPriority(storage, "corrupt", decode);
	const first = index.insert(null, "1".repeat(57), 1);
	const root = index.insert(first, "2".repeat(57), 2);
	const saved = storage.read(collection, String(root));
	for (const node of [
		{ format: 2, kind: "branch", prefix: "", children: { "1": root, "2": first } },
		{ format: 2, kind: "branch", prefix: "x", children: { "1": first, "2": first } },
		{ format: 2, kind: "branch", prefix: "", children: { "1": first } },
		{ format: 2, kind: "leaf", prefix: "1", value: 1 },
		{ format: 3, kind: "leaf", prefix: "1".repeat(57), value: 1 },
	]) {
		storage.write(collection, String(root), node);
		assert.throws(() => index.before(root, "f".repeat(57)), /invalid priority/);
	}
	storage.write(collection, String(root), saved);
	const branch = saved as { children: Record<string, number> };
	const child = branch.children["2"]!;
	const leaf = storage.read(collection, String(child));
	storage.write(collection, String(child), { format: 2, kind: "leaf", prefix: "3".repeat(57), value: 2 });
	assert.throws(() => index.before(root, "f".repeat(57)), /invalid priority/);
	storage.write(collection, String(child), leaf);
	assert.equal(index.before(root, "f".repeat(57)), 2);
});
