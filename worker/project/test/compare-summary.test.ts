// compare's summary (abso issue 680): every file a full compare lists, with its size in UTF-8 bytes and SHA-256 before
// and after instead of its texts, or its blob's hash for a binary file. The same on a writer-backed project as in
// memory.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const held = (sha: string) => sha === A || sha === B;

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
	project.init(
		{ "keep.txt": "same\n", "edit.txt": "one\n", "gone.txt": "bye\n", "run.sh": "echo\n" },
		0,
		{},
		{ "logo.png": A },
	);
	project.record(
		"ann",
		{ "edit.txt": "one\nzwei ü\n", "gone.txt": null, "new.txt": "hello\n" },
		1,
		{ "run.sh": { exec: true } },
		{ "logo.png": B },
	);
	assert.equal(project.publish("ann", "Changes", 2).ok, true);
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("compare's summary lists what compare does, as sizes and SHA-256s", () => {
	for (const project of [new Project(new MemoryStore(), { hasBlob: held }), writer()]) {
		history(project);
		const full = project.compare(0, 1);
		const summary = project.compare(0, 1, { summary: true });
		if ("summary" in full || !("summary" in summary)) throw Error("compare answered the wrong shape");
		assert.deepEqual(
			summary.files.map((f) => f.path),
			full.files.map((f) => f.path),
		);
		for (const f of full.files) {
			const s: (typeof summary.files)[number] = summary.files.find((x) => x.path === f.path)!;
			const sum = (text: string | null, blob: string | null | undefined) =>
				text === null ? null : blob ? { blob } : { size: Buffer.byteLength(text, "utf8"), sha256: sha(text) };
			assert.deepEqual(s.before, sum(f.before, f.blob?.before ?? null), `${f.path} before`);
			assert.deepEqual(s.after, sum(f.after, f.blob?.after ?? null), `${f.path} after`);
			assert.deepEqual(s.mode, f.mode);
			assert.deepEqual(s.blob, f.blob);
		}
		const edited = summary.files.find((f) => f.path === "edit.txt")!;
		assert.deepEqual(edited.after, { size: Buffer.byteLength("one\nzwei ü\n", "utf8"), sha256: sha("one\nzwei ü\n") });
		assert.equal(summary.files.find((f) => f.path === "gone.txt")!.after, null);
		assert.deepEqual(summary.files.find((f) => f.path === "logo.png")!.after, { blob: B });
		assert.ok(!JSON.stringify(summary).includes("zwei"), "no texts");
	}
});
