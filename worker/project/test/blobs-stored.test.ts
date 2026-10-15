// Binary files on a writer-backed project (abso Capacity, View.blobs): the blob list is read from file attributes
// alone, with no file laid out. It must answer as the in-memory project does: a file binary from the start, one that
// turns binary and back to text, and one deleted, at every version and in each agent's draft.

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const held = (sha: string) => [A, B, C].includes(sha);

function writer() {
	const storage = new SqlState();
	const entries = storedArray<Entry>(storage, "canonical-log");
	const store: ProjectStore = {
		append(batch) {
			for (const entry of batch) entries.push(entry);
		},
	};
	return new Project(store, { writerStorage: storage, hasBlob: held });
}

function history(project: Project) {
	project.init({ "README.md": "hi\n", "notes.txt": "notes\n" }, 0, {}, { "logo.png": A, "old.bin": B });
	project.sync("ann");
	project.sync("bob");
	project.record("ann", { "old.bin": null }, 1, {}, { "logo.png": B, "README.md": C });
	assert.equal(project.publish("ann", "README turns binary, old.bin goes", 2).ok, true);
	project.sync("bob");
	project.record("bob", { "README.md": "text again\n" }, 3);
	assert.equal(project.publish("bob", "README is text again", 4).ok, true);
	project.sync("cy");
	project.record("cy", {}, 5, {}, { "icon.png": C });
}

test("a stored writer's blob list matches the in-memory project's at every version and draft", () => {
	const oracle = new Project(new MemoryStore(), { hasBlob: held });
	const project = writer();
	history(oracle);
	history(project);
	assert.deepEqual(oracle.blobs(), { "logo.png": B });
	assert.deepEqual(project.blobs(), oracle.blobs());
	for (let v = 0; v <= oracle.version; v++)
		assert.deepEqual(project.viewAt(v).blobs(), oracle.viewAt(v).blobs(), `version ${v}`);
	for (const agent of ["ann", "bob", "cy"])
		assert.deepEqual(project.draftOf(agent)?.view.blobs(), oracle.draftOf(agent)?.view.blobs(), agent);
	assert.deepEqual(oracle.draftOf("cy")?.view.blobs(), { "icon.png": C, "logo.png": B });
});
