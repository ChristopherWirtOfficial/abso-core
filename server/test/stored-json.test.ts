import assert from "node:assert/strict";
import { test } from "node:test";
import { StoredText } from "../../src/engine/stored-text.ts";
import { StoredJson, storeJson } from "../src/stored-json.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("large JSON text streams into bounded SQLite values", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const state = new SqliteWriterState(database, "decoded");
	const root = storeJson(
		state,
		"entry",
		(function* () {
			yield '{"line":"';
			for (let i = 0; i < 500; i++) yield "x".repeat(16384);
			yield '","sequence":0}';
		})(),
	);
	assert.deepEqual(state.read("entry", String(root)), { kind: "object", count: 2 });
	const line = state.read("entry:edges", JSON.stringify([root, "line"])) as number;
	let length = 0;
	for (const chunk of new StoredText(state, "entry:text").chunks(String(line))) length += chunk.length;
	assert.equal(length, 8192000);
	assert.ok((database.db.prepare("SELECT MAX(length(value)) AS n FROM writer_state").get()!.n as number) < 100000);
	const before = database.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all();
	assert.throws(() => storeJson(state, "failed", ['{"line":"', "x".repeat(50000), '",oops}']), /JSON/);
	assert.deepEqual(
		database.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		before,
	);
	assert.equal(state.read("failed", "root"), undefined);
});

test("disk JSON reads selected children without reading unrelated text", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const state = new SqliteWriterState(database, "decoded");
	storeJson(state, "entry", [
		'{"ignored":"',
		"x".repeat(50000),
		'","items":[true,null,42],"duplicate":1,"duplicate":2}',
	]);
	const originalRead = state.read.bind(state);
	state.read = (collection, key) => {
		assert.ok(!collection.includes(":text"), "metadata lookup read text payload");
		return originalRead(collection, key);
	};
	const root = new StoredJson(state, "entry");
	assert.equal(root.kind, "object");
	assert.equal(root.child("missing"), undefined);
	assert.equal(root.child("duplicate")!.scalar(), 2);
	assert.deepEqual(
		[...root.child("items")!.elements()].map((node) => node.scalar()),
		[true, null, 42],
	);
	assert.equal(root.child("items")!.child(3), undefined);
	state.write("entry:edges", JSON.stringify([root.child("items")!.id, "1"]), 999999);
	assert.throws(() => root.child("items")!.child(1), /identity/);
});

test("disk JSON preserves JSON numeric overflow and negative zero", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const state = new SqliteWriterState(database, "decoded");
	storeJson(state, "numbers", ["[1e400,-1e400,-0,1.25]"]);
	assert.deepEqual(
		[...new StoredJson(state, "numbers").elements()].map((node) => node.scalar()),
		JSON.parse("[1e400,-1e400,-0,1.25]"),
	);
});

test("disk JSON object traversal preserves unique keys and last duplicate values", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const state = new SqliteWriterState(database, "decoded");
	storeJson(state, "object", ['{"__proto__":1,"a":2,"__proto__":3,"constructor":4}']);
	const object = new StoredJson(state, "object");
	assert.deepEqual(
		[...object.properties()].map(([key, node]) => [key, node.scalar()]),
		[
			["__proto__", 3],
			["a", 2],
			["constructor", 4],
		],
	);
	state.remove("object:keys", JSON.stringify([object.id, 1]));
	assert.throws(() => [...object.properties()], /missing stored JSON object key/);
});
