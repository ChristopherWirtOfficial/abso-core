import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonChunkCursor } from "../src/json-chunk-cursor.ts";

test("JSON strings decode exactly across every input boundary", () => {
	const values = ["", "plain", 'quotes" and slash\\', "\n\r\t\b\f", "\uD83D\uDE00", "\uD800", "\uDC00"];
	const encoded = values.map((value) => JSON.stringify(value));
	encoded.push('"\\uD83D\\uDE00\\u0000\\/"');
	for (const json of encoded)
		for (let split = 0; split <= json.length; split++) {
			const cursor = new JsonChunkCursor([json.slice(0, split), "", json.slice(split), ","]);
			assert.equal([...cursor.stringChunks()].join(""), JSON.parse(json));
			assert.equal(cursor.take(), ",");
			assert.equal(cursor.peek(), undefined);
		}
	for (const invalid of ['"unterminated', '"\\x"', '"\\u12xz"', '"\\u123', '"raw\ncontrol"']) {
		const cursor = new JsonChunkCursor(invalid.split(""));
		assert.throws(() => [...cursor.stringChunks()], /JSON/);
	}
});

test("long JSON strings decode in fixed-size output chunks", () => {
	let closed = false;
	const cursor = new JsonChunkCursor(
		(function* () {
			try {
				yield '"';
				for (let i = 0; i < 500; i++) yield "x".repeat(16384);
				yield '"';
			} finally {
				closed = true;
			}
		})(),
	);
	let count = 0;
	for (const chunk of cursor.stringChunks()) {
		assert.ok(chunk.length <= 16384);
		count += chunk.length;
	}
	assert.equal(count, 8192000);
	cursor.close();
	assert.equal(closed, true);
});
