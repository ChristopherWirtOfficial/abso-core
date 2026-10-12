import assert from "node:assert/strict";
import { test } from "node:test";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project, type WriterSource } from "../project.ts";

function history() {
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "zero\n" }, 0);
	for (let i = 1; i <= 8; i++) {
		project.record("writer", { "a.txt": `${i}\n` }, i * 2);
		project.publish("writer", `Edit ${i}`, i * 2 + 1);
	}
	const source: WriterSource = { generation: 8, logLength: log.entries.length, sharedVersion: project.version };
	const frames = log.entries.map((entry, seq) => ({ seq, json: JSON.stringify(entry) }));
	return { log, project, source, frames };
}

test("nonempty canonical history adopts in bounded restartable pages without Project.load", (t) => {
	const { log, project: oracle, source, frames } = history();
	t.mock.method(Project, "load", () => {
		throw new Error("full replay is forbidden");
	});
	const storage = new SqlState();
	const before = JSON.stringify(log.entries);
	let next = 0;
	while (next < frames.length) {
		const result = Project.adoptWriterPage(storage, {
			source,
			from: next,
			frames: frames.slice(next, next + 2),
			maxEntries: 2,
			maxBytes: 16_384,
			currentSource: () => source,
		});
		assert.ok(result.entries <= 2 && result.bytes <= 16_384);
		next = result.next;
		if (!result.ready) assert.throws(() => Project.openWriter(log, storage, next), /adoption is incomplete/);
	}
	assert.equal(JSON.stringify(log.entries), before, "adoption never rewrites or appends canonical entries");
	const reopened = Project.openWriter(log, storage, log.entries.length);
	assert.deepEqual(reopened.files(), oracle.files());
	assert.deepEqual(reopened.status(), oracle.status());
	assert.deepEqual(reopened.changes(0), oracle.changes(0));
	storage.transaction(() => reopened.record("writer", { "a.txt": "after adoption\n" }, 30));
	storage.transaction(() => reopened.publish("writer", "After adoption", 31));
	assert.equal(Project.openWriter(log, storage, log.entries.length).files()["a.txt"], "after adoption\n");
	storage.db.close();
});

test("adoption rejects stale source and rolls back a page if the source changes before commit", () => {
	const { source, frames } = history();
	const storage = new SqlState();
	const snapshot = () => storage.db.prepare("SELECT * FROM state ORDER BY collection, key").all();
	const input = { source, from: 0, frames: frames.slice(0, 2), maxEntries: 2, maxBytes: 16_384 };
	let calls = 0;
	assert.throws(
		() =>
			Project.adoptWriterPage(storage, {
				...input,
				currentSource: () => (++calls === 1 ? source : { ...source, generation: source.generation + 1 }),
			}),
		/source changed during/,
	);
	assert.deepEqual(snapshot(), []);
	Project.adoptWriterPage(storage, { ...input, currentSource: () => source });
	const before = snapshot();
	assert.throws(
		() => Project.adoptWriterPage(storage, { ...input, currentSource: () => source }),
		/cursor does not match/,
	);
	assert.throws(
		() =>
			Project.adoptWriterPage(storage, {
				...input,
				from: 2,
				source: { ...source, generation: 9 },
				currentSource: () => ({ ...source, generation: 9 }),
			}),
		/source or cursor/,
	);
	assert.deepEqual(snapshot(), before);
	storage.db.close();
});

test("oversized and noncontiguous adoption pages leave no partial indexes", () => {
	const { source, frames } = history();
	for (const page of [
		{ frames: frames.slice(0, 2), maxEntries: 1, maxBytes: 16_384 },
		{ frames: frames.slice(0, 2), maxEntries: 2, maxBytes: 1 },
		{ frames: [frames[0]!, frames[2]!], maxEntries: 2, maxBytes: 16_384 },
	]) {
		const storage = new SqlState();
		assert.throws(
			() => Project.adoptWriterPage(storage, { source, from: 0, currentSource: () => source, ...page }),
			/bounds|bound|noncontiguous/,
		);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state").all(), []);
		storage.db.close();
	}
});
