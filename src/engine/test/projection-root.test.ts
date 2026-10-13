import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createProjectionRoot,
	type ProjectionIdentity,
	type ProjectionRoots,
	readProjectionRoot,
} from "../experimental/projection-root.ts";
import { SqlState } from "./storage-helper.ts";

test("experimental roots bind identity before storage access and remain immutable", () => {
	const storage = new SqlState();
	try {
		const expected: ProjectionIdentity = {
			database: "db",
			namespace: "index",
			sourceGeneration: 1,
			sourceLength: 2,
			sourceDigest: "a".repeat(64),
			membership: "closed:2",
			registry: "files:1",
			defaultFile: "f.txt",
		};
		const pages: ProjectionRoots = {
			sequence: 3,
			sequenceRoot: 0,
			sequenceNext: 1,
			locator: 4,
			children: 5,
			membership: 6,
			attributes: null,
		};
		const handle = createProjectionRoot(storage, expected, 0, pages);
		assert.deepEqual(readProjectionRoot(storage, handle, expected), pages);
		for (const field of Object.keys(expected) as (keyof ProjectionIdentity)[]) {
			const changed = {
				...expected,
				[field]:
					typeof expected[field] === "number"
						? Number(expected[field]) + 1
						: field === "sourceDigest"
							? "b".repeat(64)
							: `${expected[field]}:other`,
			};
			const reads = storage.reads,
				writes = storage.writes;
			assert.throws(() => readProjectionRoot(storage, handle, changed), /identity mismatch/);
			assert.equal(storage.reads, reads);
			assert.equal(storage.writes, writes);
		}
		assert.throws(() => createProjectionRoot(storage, expected, 0, pages), /already exists/);
		const copy = readProjectionRoot(storage, handle, expected) as { sequence: number | null };
		copy.sequence = 999;
		assert.deepEqual(readProjectionRoot(storage, handle, expected), pages);
		assert.throws(
			() =>
				storage.transaction(() => {
					createProjectionRoot(storage, expected, 1, pages);
					throw Error("fail after root");
				}),
			/fail after root/,
		);
		assert.throws(() => readProjectionRoot(storage, { ...handle, id: 1 }, expected), /invalid projection root record/);
		storage.write('experimental-projection:["db","index"]:roots', "0", {
			format: 1,
			id: 0,
			identity: expected,
			roots: { ...pages, locator: -1 },
		});
		assert.throws(() => readProjectionRoot(storage, handle, expected), /invalid projection page reference/);
	} finally {
		storage.db.close();
	}
});
