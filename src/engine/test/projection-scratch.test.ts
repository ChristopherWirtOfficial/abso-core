import assert from "node:assert/strict";
import { test } from "node:test";
import { withProjectionScratch } from "../projection-scratch.ts";
import { CachedStateStorage, type GraphStateStorage } from "../state-source.ts";
import { SqlState } from "./storage-helper.ts";

test("projection scratch is isolated, detached and rolled back inside canonical transactions", () => {
	const source = new SqlState();
	const storage = new CachedStateStorage(source);
	try {
		storage.transaction(() => {
			storage.write("canonical", "before", 1);
			let escaped: GraphStateStorage | undefined;
			const result = withProjectionScratch(
				storage,
				() => {},
				(scratch) => {
					escaped = scratch;
					scratch.write("canonical", "before", 99);
					const inner = withProjectionScratch(
						storage,
						() => {},
						(nested) => {
							assert.equal(nested.read("canonical", "before"), undefined);
							nested.write("canonical", "before", 101);
							return nested.read("canonical", "before");
						},
					);
					assert.equal(inner, 101);
					return { value: scratch.read("canonical", "before"), data: new Int32Array([1, 2]) };
				},
			);
			assert.deepEqual(result, { value: 99, data: new Int32Array([1, 2]) });
			assert.throws(() => escaped!.write("x", "y", true), /ended/);
			assert.equal(storage.retainedEntries, 0, "scratch rollback invalidates every cached value");
			assert.equal(storage.read("canonical", "before"), 1);
			storage.write("canonical", "after", 2);
		});
		assert.equal(source.db.prepare("SELECT count(*) AS n FROM state").get()!.n, 2);
		assert.equal(storage.retainedEntries, 2, "only the canonical read and successful counter write remain");
		assert.equal(storage.read("canonical", "after"), 2);
	} finally {
		source.db.close();
	}
});

test("projection errors, changed identities and escaping capabilities cannot commit scratch", () => {
	const source = new SqlState();
	try {
		let checks = 0;
		assert.throws(
			() =>
				withProjectionScratch(
					source,
					() => {
						if (++checks === 2) throw new Error("identity changed");
					},
					(scratch) => {
						scratch.write("x", "y", 1);
						return 2;
					},
				),
			/identity changed/,
		);
		assert.throws(
			() =>
				withProjectionScratch(
					source,
					() => {},
					(scratch) => {
						scratch.write("x", "y", 1);
						throw new Error("failed computation");
					},
				),
			/failed computation/,
		);
		assert.throws(
			() =>
				withProjectionScratch(
					source,
					() => {},
					(scratch) => scratch,
				),
			/clone|cloned/i,
		);
		assert.throws(
			() =>
				withProjectionScratch(
					source,
					() => {},
					() => Promise.resolve(1),
				),
			/synchronously/,
		);
		assert.equal(source.db.prepare("SELECT count(*) AS n FROM state").get()!.n, 0);
	} finally {
		source.db.close();
	}
});
