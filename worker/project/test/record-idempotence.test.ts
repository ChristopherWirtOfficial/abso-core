import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const BLOB_A = "a".repeat(64);
const BLOB_B = "b".repeat(64);

test("replaying identical recorded text, deletion, blob, and mode changes adds no semantic events", () => {
	const heldBlobs = new Set([BLOB_A, BLOB_B]);
	const store = new MemoryStore();
	const project = new Project(store, { hasBlob: (sha) => heldBlobs.has(sha) });
	project.init(
		{ "text.txt": "old text\n", "delete.txt": "remove me\n", "run.sh": "echo hi\n" },
		0,
		{},
		{ "image.bin": BLOB_A },
	);
	project.sync("ann");

	const replay = (record: () => { changed?: readonly string[] }) => {
		const before = store.entries.length;
		const first = record();
		const afterFirst = store.entries.length;
		assert.ok(afterFirst > before, "the initial recording creates semantic events");
		const second = record();
		assert.deepEqual(second.changed, []);
		assert.equal(store.entries.length, afterFirst, "an identical replay appends no semantic events");
		return first;
	};

	replay(() => project.record("ann", { "text.txt": "new text\n" }, 1));
	replay(() => project.record("ann", { "delete.txt": null }, 2));
	replay(() => project.record("ann", {}, 3, {}, { "image.bin": BLOB_B }));
	replay(() => project.record("ann", {}, 4, { "run.sh": { exec: true } }));
});
