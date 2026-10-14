import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { applyGitDeltaChunks } from "../src/git-delta-stream.ts";
import { GitObjectBytes } from "../src/git-object-bytes.ts";
import { memoryStorage } from "./helpers.ts";

const integer = (value: number) => {
	const bytes = [];
	do {
		const part = value % 128;
		value = Math.floor(value / 128);
		bytes.push(part | (value ? 128 : 0));
	} while (value);
	return bytes;
};
test("disk delta output has exact Git identity and partial failures roll back", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const objects = new GitObjectBytes(storage);
	const bytes = Uint8Array.from({ length: 200000 }, (_, i) => i % 251);
	const base = objects.put("blob", (write) => write(bytes), 200000);
	const instructions = Uint8Array.from([...integer(bytes.length), ...integer(131075), 0xc0, 2, 3, 4, 5, 6]);
	const delta = objects.put("blob", (write) => write(instructions), 100);
	const result = objects.put(
		"blob",
		(write) => {
			applyGitDeltaChunks(delta, base, write, 200000);
		},
		200000,
	);
	const expected = Buffer.concat([bytes.subarray(0, 131072), new Uint8Array([4, 5, 6])]);
	assert.equal(result.oid, createHash("sha1").update(`blob ${expected.length}\0`).update(expected).digest("hex"));
	assert.deepEqual(result.read(65530, 100), new Uint8Array(expected.subarray(65530, 65630)));
	assert.equal(result.byteLength, expected.length);
	const counts = () => [
		storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_bytes").get()!.n,
		storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n,
	];
	const bad = objects.put("blob", (write) => write(Uint8Array.from([...instructions, 0])), 101);
	const before = counts();
	assert.throws(
		() =>
			objects.put(
				"blob",
				(write) => {
					applyGitDeltaChunks(bad, base, write, 200000);
				},
				200000,
			),
		/invalid Git delta instruction/,
	);
	assert.deepEqual(counts(), before);
	assert.throws(
		() =>
			objects.put(
				"blob",
				(write) => {
					write(bytes);
					throw Error("injected producer failure");
				},
				200000,
			),
		/injected producer failure/,
	);
	assert.deepEqual(counts(), before);
	assert.throws(() => objects.put("blob", (write) => write(bytes), 100000), /exceeds byte limit/);
	assert.deepEqual(counts(), before);
	assert.deepEqual(base.read(0, 100), bytes.slice(0, 100));
	assert.equal(objects.put("blob", () => {}, 0).oid, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	objects.dispose();
	assert.deepEqual(counts(), [0, 0]);
	assert.throws(() => base.read(0, 1), /closed/);
});
