import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderedIndex, orderedChildKey } from "../ordered-index.ts";
import { SqlState } from "./storage-helper.ts";

test("ordered children retain priority across storage reopen and transactional split failures", () => {
	const storage = new SqlState();
	try {
		const children = Array.from({ length: 513 }, (_, n) => ({
			n,
			replaces: n % 2,
			lamport: n % 7,
			seq: Math.floor(n / 8),
			k: n % 8,
		}));
		const expected = [...children]
			.sort((a, b) => b.replaces - a.replaces || b.lamport - a.lamport || b.seq - a.seq || a.k - b.k || a.n - b.n)
			.map((c) => c.n);
		const index = new OrderedIndex(storage, "ordered", "parent");
		for (const child of [...children].reverse()) index.insert(orderedChildKey(child), child.n);
		assert.deepEqual([...new OrderedIndex(storage, "ordered", "parent").values()], expected);
		storage.reads = 0;
		assert.equal(new OrderedIndex(storage, "ordered", "parent").values().next().value, expected[0]);
		assert.ok(storage.reads <= 59);
		const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		const child = { n: 514, replaces: 1, lamport: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER, k: 0 };
		let failed = 0,
			complete = false;
		for (let offset = 1; offset < 12; offset++) {
			storage.failWrite = storage.writes + offset;
			try {
				index.insert(orderedChildKey(child), child.n);
				complete = true;
				break;
			} catch (error) {
				assert.match(String(error), /injected/);
				failed++;
				assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
			}
		}
		assert.ok(complete && failed >= 3);
		storage.failWrite = Infinity;
		assert.deepEqual([...new OrderedIndex(storage, "ordered", "parent").values()], [514, ...expected]);
		index.insert(orderedChildKey(child), child.n);
		assert.deepEqual([...index.values()], [514, ...expected]);
		assert.throws(() => index.insert(orderedChildKey(child), 999), /reused/);
		assert.deepEqual([...new OrderedIndex(storage, "ordered", "other").values()], []);
	} finally {
		storage.db.close();
	}
});

test("ordered index refuses malformed state and cycles instead of following them", () => {
	const storage = new SqlState();
	try {
		const index = new OrderedIndex(storage, "ordered", "parent");
		assert.throws(() => orderedChildKey({ n: 0, replaces: 2, lamport: 0, seq: 0, k: 0 }), /priority/);
		assert.throws(() => index.insert("bad", 0), /entry/);
		index.insert("0".repeat(57), 0);
		index.insert("1".repeat(57), 1);
		const node = storage.read("ordered", JSON.stringify(["parent", 0])) as {
			prefix: string;
			children: (number | null)[];
		};
		node.children[0] = 0;
		storage.write("ordered", JSON.stringify(["parent", 0]), node);
		assert.throws(() => [...index.values()], /node/);
	} finally {
		storage.db.close();
	}
});

test("ordered successor cursors skip earlier subtrees and retain tied-priority order", () => {
	const storage = new SqlState();
	try {
		const index = new OrderedIndex(storage, "ordered", "parent");
		const children = Array.from({ length: 1025 }, (_, n) => ({
			n,
			replaces: 0,
			lamport: 4,
			seq: Math.floor(n / 8),
			k: n % 8,
		}));
		for (const child of children) index.insert(orderedChildKey(child), child.n);
		const ordered = [...children].sort((a, b) => orderedChildKey(a).localeCompare(orderedChildKey(b)));
		for (const position of [0, 1, 255, 511, 1023, 1024]) {
			const cursor = orderedChildKey(ordered[position]!);
			storage.reads = 0;
			const first = new OrderedIndex(storage, "ordered", "parent").values(cursor).next().value;
			assert.equal(first, ordered[position + 1]?.n);
			assert.ok(storage.reads < 60, "first successor must skip earlier history");
			assert.deepEqual(
				[...index.values(cursor)],
				ordered.slice(position + 1).map((child) => child.n),
			);
		}
		assert.throws(() => [...index.values("bad")], /cursor/);
	} finally {
		storage.db.close();
	}
});
