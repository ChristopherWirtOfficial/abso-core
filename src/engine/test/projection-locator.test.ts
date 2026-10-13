import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionLocator } from "../experimental/projection-locator.ts";
import { SqlState } from "./storage-helper.ts";

const decode = (value: unknown): number => {
	if (!Number.isSafeInteger(value)) throw Error("invalid payload");
	return value as number;
};
test("experimental locator preserves sparse old roots and rejects corrupt storage", () => {
	const storage = new SqlState();
	try {
		const index = new ProjectionLocator(storage, "test", decode),
			keys = [0, 0xffffffff, 16, 1, 0x80000000, 255, 256];
		let root: number | null = null;
		const versions: number[] = [];
		for (const id of keys) {
			root = index.set(root, id, id);
			versions.push(root);
		}
		for (let i = 0; i < versions.length; i++)
			for (let j = 0; j < keys.length; j++)
				assert.equal(index.get(versions[i]!, keys[j]!), j <= i ? keys[j] : undefined);
		const before = JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		storage.failWrite = storage.writes + 3;
		assert.throws(() => index.set(root, 42, 42), /injected/);
		assert.equal(JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all()), before);
		storage.failWrite = Infinity;
		for (const id of [-1, 2 ** 32, 0.5, NaN]) assert.throws(() => index.get(root, id), /identity limit/);
		const collection = 'experimental-locator:"test"',
			saved = storage.read(collection, String(root));
		for (const corrupt of [
			{ format: 2, kind: "leaf", prefix: "00000000", value: 0 },
			{ format: 1, kind: "leaf", prefix: "0", value: 0 },
			{ format: 1, kind: "branch", prefix: "", children: { "0": root, f: 0 } },
			{ format: 1, kind: "branch", prefix: "", children: { "00": 0, f: 1 } },
		]) {
			storage.write(collection, String(root), corrupt);
			assert.throws(() => index.get(root, 0), /invalid locator/);
		}
		storage.write(collection, String(root), saved);
		assert.equal(index.get(root, 16), 16);
		const leaf = index.set(null, 7, 7);
		storage.write(collection, String(leaf), { format: 1, kind: "leaf", prefix: "00000007", value: "bad" });
		assert.throws(() => index.get(leaf, 7), /invalid payload/);
	} finally {
		storage.db.close();
	}
});

test("bounded locator batches preserve old roots, discard intermediate pages, and roll back writes", () => {
	const db = new SqlState();
	try {
		const index = new ProjectionLocator(db, "batch", decode);
		const old = index.set(null, 0, 1);
		const values = Array.from({ length: 64 }, (_, i) => [i, i + 10] as const);
		const before = db.writes;
		const root = index.setMany(old, values);
		const batchWrites = db.writes - before;
		assert.equal(index.get(old, 0), 1);
		for (const [id, value] of values) assert.equal(index.get(root, id), value);
		const plain = new ProjectionLocator(db, "plain", decode);
		let sequential: number | null = plain.set(null, 0, 1);
		const baseline = db.writes;
		for (const [id, value] of values) sequential = plain.set(sequential, id, value);
		assert.ok(batchWrites < (db.writes - baseline) / 2);
		const rows = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		// Fail every persisted page and the final allocation-counter write.
		for (let offset = 1; offset <= batchWrites; offset++) {
			db.failWrite = db.writes + offset;
			assert.throws(() => index.setMany(old, values), /injected/);
			assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), rows);
		}
		db.failWrite = Infinity;
		assert.throws(
			() =>
				index.setMany(
					root,
					Array.from({ length: 257 }, () => [0, 1] as const),
				),
			/batch limit/,
		);
		assert.equal(index.setMany(root, []), root);
		const duplicate = index.setMany(root, [
			[0, 100],
			[0, 200],
			[0xffffffff, 300],
		]);
		assert.equal(index.get(duplicate, 0), 200);
		assert.equal(index.get(duplicate, 0xffffffff), 300);
		assert.equal(index.get(root, 0), 10);
		const stable = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		assert.throws(
			() =>
				index.setMany(duplicate, [
					[1, 3],
					[2 ** 32, 4],
				]),
			/identity limit/,
		);
		assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), stable);
	} finally {
		db.db.close();
	}
});
