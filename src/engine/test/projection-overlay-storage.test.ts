import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionOverlayStorage } from "../experimental/projection-overlay-storage.ts";
import { SqlState } from "./storage-helper.ts";

test("temporary projection pages shadow committed pages and cleanup preserves durable writes", () => {
	const storage = new SqlState();
	try {
		storage.write("pages", "one", { n: 1 });
		storage.write("pages", "two", { n: 2 });
		const overlay = new ProjectionOverlayStorage(storage, "read-a");
		storage.transaction(() => {
			overlay.write("pages", "one", { n: 10 });
			overlay.remove("pages", "two");
			overlay.write("pages", "three", { n: 3 });
			assert.deepEqual(overlay.read("pages", "one"), { n: 10 });
			assert.equal(overlay.read("pages", "two"), undefined);
			assert.deepEqual([...overlay.entries("pages")].sort(), [
				["one", { n: 10 }],
				["three", { n: 3 }],
			]);
			assert.throws(() => new ProjectionOverlayStorage(storage, "read-a"), /occupied/);
			assert.throws(
				() =>
					overlay.transaction(() => {
						overlay.write("pages", "one", 99);
						throw Error("fail");
					}),
				/fail/,
			);
			assert.deepEqual(overlay.read("pages", "one"), { n: 10 });
			storage.write("roots", "committed", { root: 7 });
			const iterator = overlay.entries("pages")[Symbol.iterator]();
			iterator.next();
			overlay.close();
			assert.throws(() => iterator.next(), /closed/);
		});
		assert.deepEqual(
			[...storage.entries("pages")],
			[
				["one", { n: 1 }],
				["two", { n: 2 }],
			],
		);
		assert.deepEqual(storage.read("roots", "committed"), { root: 7 });
		assert.deepEqual([...storage.entries("projection:temporary:read-a")], []);
		assert.throws(() => overlay.read("pages", "one"), /closed/);
	} finally {
		storage.db.close();
	}
});
