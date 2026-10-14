import assert from "node:assert/strict";
import { test } from "node:test";
import { StoredJson, storeJson } from "../src/stored-json.ts";
import { storedJsonView } from "../src/stored-json-view.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("stored JSON views expose array operations without decoding unrelated payloads", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const state = new SqliteWriterState(database, "view");
	const input = { type: "draft", atom: { deps: ["a0", "a1"], message: "x".repeat(50000) } };
	storeJson(state, "entry", [JSON.stringify(input)]);
	const read = state.read.bind(state);
	let chunks = 0;
	state.read = (collection, key) => {
		if (collection.endsWith(":text:chunks")) chunks++;
		return read(collection, key);
	};
	const value = storedJsonView(new StoredJson(state, "entry")) as typeof input;
	assert.equal(chunks, 0);
	assert.equal(value.atom.deps.length, 2);
	assert.equal(chunks, 0);
	assert.deepEqual(
		value.atom.deps.map((x) => x),
		["a0", "a1"],
	);
	assert.equal(chunks, 2);
	assert.equal("message" in value.atom, true);
	assert.throws(() => {
		value.atom.deps[0] = "changed";
	}, /read-only/);
	assert.deepEqual(JSON.parse(JSON.stringify(value)), input);
});
