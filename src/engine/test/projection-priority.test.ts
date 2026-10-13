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
