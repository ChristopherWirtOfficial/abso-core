import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGitDeltaChunks, type GitByteRanges } from "../src/git-delta-stream.ts";

const ranges = (bytes: Uint8Array): GitByteRanges => ({
	byteLength: bytes.length,
	read(start, length) {
		assert.ok(length <= 65536);
		return bytes.slice(start, start + length);
	},
});
const integer = (value: number) => {
	const bytes = [];
	do {
		const next = value % 128;
		value = Math.floor(value / 128);
		bytes.push(next | (value ? 128 : 0));
	} while (value);
	return bytes;
};
test("delta copy and literal instructions use bounded base reads and output", () => {
	const base = Uint8Array.from({ length: 200000 }, (_, i) => i % 251);
	// Copy 131072 bytes from offset zero, then append three literal bytes.
	const delta = Uint8Array.from([...integer(base.length), ...integer(131075), 0xc0, 2, 3, 4, 5, 6]);
	const output: Uint8Array[] = [];
	assert.equal(
		applyGitDeltaChunks(
			ranges(delta),
			ranges(base),
			(chunk) => {
				assert.ok(chunk.length <= 65536);
				output.push(chunk);
			},
			200000,
		),
		131075,
	);
	assert.deepEqual(Buffer.concat(output), Buffer.concat([base.subarray(0, 131072), new Uint8Array([4, 5, 6])]));
});
test("delta refuses malformed instructions, bounds and truncated input", () => {
	for (const bytes of [
		[1, 0],
		[0, 1, 0],
		[0, 1, 1],
		[0, 1, 0x80],
		[0, 2, 1, 7],
		[0, 0, 1, 7],
	])
		assert.throws(() => applyGitDeltaChunks(ranges(Uint8Array.from(bytes)), ranges(new Uint8Array()), () => {}, 10));
	let writes = 0;
	assert.throws(
		() =>
			applyGitDeltaChunks(
				ranges(new Uint8Array([0, 11])),
				ranges(new Uint8Array()),
				() => {
					writes++;
				},
				10,
			),
		/exceeds bound/,
	);
	assert.equal(writes, 0);
});
