import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionOverlayStorage } from "../experimental/projection-overlay-storage.ts";
import { SqlState } from "./storage-helper.ts";

test("host cleanup deletes only its overlay and a failed deletion rolls back without scanning", (t) => {
	const storage = new SqlState();
	try {
		let fail = true;
		const overlay = new ProjectionOverlayStorage(storage, "bulk", (collection) => {
			assert.equal(collection, "projection:temporary:bulk");
			storage.db.prepare("DELETE FROM state WHERE collection = ?").run(collection);
			if (fail) throw Error("cleanup failed after deletion");
		});
		storage.write("pages", "durable", 1);
		storage.write("projection:temporary:other", "other", 2);
		for (let i = 0; i < 100; i++) overlay.write("pages", String(i), i);
		const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		t.mock.method(storage, "entries", () => {
			throw Error("cleanup must not enumerate rows");
		});
		assert.throws(() => overlay.close(), /cleanup failed/);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		assert.equal(overlay.read("pages", "99"), 99);
		fail = false;
		overlay.close();
		assert.equal(storage.read("pages", "durable"), 1);
		assert.equal(storage.read("projection:temporary:other", "other"), 2);
		assert.equal(
			storage.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection = ?").get("projection:temporary:bulk")!.n,
			0,
		);
		assert.throws(() => overlay.read("pages", "99"), /closed/);
	} finally {
		storage.db.close();
	}
});

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
