import assert from "node:assert/strict";
import { test } from "node:test";
import { readonlyStoredArray, storedArray } from "../state-source.ts";
import { SqlState } from "./storage-helper.ts";

test("referenced stored lists reject missing metadata and missing elements", () => {
	const storage = new SqlState();
	try {
		assert.throws(() => readonlyStoredArray(storage, "missing"), /stored list/);
		const values = storedArray<number>(storage, "values");
		values.push(1, 2, 3);
		const readonly = readonlyStoredArray<number>(storage, "values");
		assert.equal(readonly.length, 3);
		storage.remove("values", "1");
		assert.throws(() => readonly[1], /stored list/);
		storage.remove("values:meta", "length");
		assert.throws(() => readonly.length, /stored list/);
	} finally {
		storage.db.close();
	}
});
