import assert from "node:assert/strict";
import { test } from "node:test";
import { StoredText } from "../stored-text.ts";
import { SqlState } from "./storage-helper.ts";

test("stored text preserves long lines and split surrogate pairs with bounded values", () => {
	const state = new SqlState();
	try {
		const text = new StoredText(state, "text");
		const value = "x".repeat(StoredText.chunkCharacters - 1) + "\uD83D\uDE00" + "y".repeat(8100000);
		text.write("line", value);
		let count = 0;
		for (const chunk of text.chunks("line")) {
			assert.ok(chunk.length <= StoredText.chunkCharacters);
			count += chunk.length;
		}
		assert.equal(count, value.length);
		assert.equal(text.read("line"), value);
		assert.throws(() => text.write("line", "overwrite"), /already exists/);
		text.write("empty", "");
		assert.equal(text.read("empty"), "");
		const before = state.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		state.failWrite = state.writes + 2;
		assert.throws(() => text.write("failure", value), /injected/);
		assert.deepEqual(state.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		state.failWrite = Infinity;
		state.remove("text:chunks", JSON.stringify(["line", 1]));
		assert.throws(() => text.read("line"), /incomplete/);
	} finally {
		state.db.close();
	}
});

test("streamed text repacks small chunks and rolls back interrupted input", () => {
	const state = new SqlState();
	try {
		const text = new StoredText(state, "stream");
		const value = `${"a".repeat(20000)}\uD83D\uDE00${"b".repeat(20000)}`;
		text.writeChunks(
			"unicode",
			(function* () {
				for (const unit of value.split("")) yield unit;
			})(),
		);
		assert.equal(text.read("unicode"), value);
		const rows = () => state.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		const before = rows();
		assert.throws(
			() =>
				text.writeChunks(
					"interrupted",
					(function* () {
						yield "x".repeat(StoredText.chunkCharacters);
						yield "tail";
						throw Error("input interrupted");
					})(),
				),
			/input interrupted/,
		);
		assert.deepEqual(rows(), before);
		assert.throws(() => text.writeChunks("oversized", ["x".repeat(StoredText.chunkCharacters + 1)]), /exceeds bound/);
		assert.deepEqual(rows(), before);
		text.writeChunks("interrupted", ["retry"]);
		assert.equal(text.read("interrupted"), "retry");
	} finally {
		state.db.close();
	}
});
