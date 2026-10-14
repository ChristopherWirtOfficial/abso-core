import assert from "node:assert/strict";
import { test } from "node:test";
import { readonlyStoredArray, storedArray } from "../state-source.ts";
import { SqlState } from "./storage-helper.ts";

test("readonly stored lists preserve array traversal and explicit enumeration", () => {
	const storage = new SqlState();
	try {
		storedArray<number>(storage, "numbers").push(10, 20, 30);
		const values = readonlyStoredArray<number>(storage, "numbers");
		assert.equal(Array.isArray(values), true);
		assert.deepEqual(
			values.map((value) => value + 1),
			[11, 21, 31],
		);
		assert.deepEqual([...values], [10, 20, 30]);
		assert.equal(JSON.stringify(values), "[10,20,30]");
		assert.deepEqual(Object.keys(values), ["0", "1", "2"]);
		assert.equal(Object.getOwnPropertyDescriptor(values, "1")?.value, 20);
		assert.throws(() => Object.defineProperty(values, "0", { value: 99 }), /read-only/);
	} finally {
		storage.db.close();
	}
});
