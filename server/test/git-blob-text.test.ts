import assert from "node:assert/strict";
import { test } from "node:test";
import { gitBlobText, InvalidGitUtf8 } from "../src/git-blob-text.ts";
import { GitIntakeTrees } from "../src/git-intake-trees.ts";
import { memoryStorage } from "./helpers.ts";

function source(bytes: Uint8Array) {
	return {
		byteLength: bytes.length,
		read(start: number, length: number) {
			assert.ok(length <= 16384);
			return bytes.slice(start, start + length);
		},
	};
}

test("Git text chunks preserve BOM and split UTF-8 semantics with bounded pieces", () => {
	for (const text of ["", "\ufefftext", "x".repeat(16383) + "🚀é中".repeat(20000), "nul\0text"]) {
		const bytes = new TextEncoder().encode(text);
		const chunks = [...gitBlobText(source(bytes))];
		assert.ok(chunks.every((chunk) => chunk.length <= 16384));
		assert.equal(chunks.join(""), new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	}
});

test("late invalid UTF-8 rolls back retained chunks without publishing a file", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const trees = new GitIntakeTrees(storage);
	const files: Record<string, string> = {};
	const bytes = new Uint8Array(100000).fill(97);
	bytes[bytes.length - 1] = 0xf0;
	assert.throws(() => trees.retainChunks(files, "bad", gitBlobText(source(bytes)), "a".repeat(40)), InvalidGitUtf8);
	assert.deepEqual(Object.keys(files), []);
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get(trees.namespace)!.n,
		0,
	);
	bytes[bytes.length - 1] = 98;
	trees.retainChunks(files, "good", gitBlobText(source(bytes)), "a".repeat(40));
	assert.equal(files.good, new TextDecoder().decode(bytes));
	trees.dispose();
});

test("Git text reading preserves storage errors instead of classifying them as binary", () => {
	const failure = new TypeError("storage failure");
	assert.throws(
		() => [
			...gitBlobText({
				byteLength: 1,
				read: () => {
					throw failure;
				},
			}),
		],
		(error) => error === failure,
	);
});
