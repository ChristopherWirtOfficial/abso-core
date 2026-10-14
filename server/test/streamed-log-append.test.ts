import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_PART_CHARACTERS, logParts, streamedLogParts } from "../src/engine-project.ts";

test("streamed canonical rows exactly match legacy serialization and boundaries", () => {
	for (const offset of [-2, -1, 0, 1, 2]) {
		const value = { text: "x".repeat(LOG_PART_CHARACTERS - 9 + offset) + '😀\ud800\n"', rest: [null, false, 3] };
		assert.deepEqual([...streamedLogParts(value)], logParts(JSON.stringify(value)));
	}
	const value = { files: Array.from({ length: 100 }, (_, i) => `${i}:` + "中".repeat(20000)) };
	assert.deepEqual([...streamedLogParts(value)], logParts(JSON.stringify(value)));
});

test("canonical row streaming never stringifies a whole object or a large string", (t) => {
	const stringify = JSON.stringify;
	t.mock.method(JSON, "stringify", (value: unknown) => {
		assert.ok(typeof value !== "object", "whole-object serialization is forbidden");
		if (typeof value === "string") assert.ok(value.length <= 16384);
		return stringify(value);
	});
	let length = 0;
	for (const part of streamedLogParts({ text: "x".repeat(6_000_000) })) {
		assert.ok(part.length <= LOG_PART_CHARACTERS);
		length += part.length;
	}
	assert.equal(length, 6_000_011);
});
