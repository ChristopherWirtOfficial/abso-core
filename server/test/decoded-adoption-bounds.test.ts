import assert from "node:assert/strict";
import { test } from "node:test";
import { SqlState } from "../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";

test("large adoption budgets require decoded frames and refuse JSON without mutation", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const log = new MemoryStore();
	new Project(log).init({ "a.txt": "small\n" }, 0);
	const source = { generation: 1, logLength: 1, sharedVersion: 0 };
	const frames = [{ seq: 0, json: JSON.stringify(log.entries[0]) }];
	const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	const input = { source, from: 0, frames, maxEntries: 1, maxBytes: 8100000, currentSource: () => source };
	assert.throws(() => Project.adoptWriterPage(storage, input), /invalid writer adoption bounds/);
	assert.throws(() => Project.adoptWriterPage(storage, { ...input, decodedFrames: true }), /requires decoded frames/);
	assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
	assert.throws(
		() =>
			Project.extendHistoricalPage(storage, {
				from: 1,
				frames,
				maxEntries: 1,
				maxBytes: 8100000,
				beginRevision() {},
				validateAuthority() {},
			}),
		/invalid historical extension bounds/,
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
});
