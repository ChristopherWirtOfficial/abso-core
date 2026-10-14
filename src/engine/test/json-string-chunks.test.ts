import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase } from "../build.ts";
import { Graph } from "../graph.ts";
import { JsonStringChunks, jsonValueChunks, registerJsonChunkValue } from "../json-value-chunks.ts";
import { StoredText } from "../stored-text.ts";
import { SqlState } from "./storage-helper.ts";

test("many stored insertion runs serialize with linear reads and support backwards access", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const files = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`f${i}`, `${i}:${"x".repeat(17000)}\n`]));
	const graph = new Graph({ storage });
	graph.add(buildBase(files, { author: "writer", message: "many runs" }));
	const stored = graph.atom("a0");
	const expected = JSON.stringify(stored);
	const before = storage.reads;
	assert.equal([...jsonValueChunks(stored)].join(""), expected);
	assert.ok(storage.reads - before < 128 * 25, `serialization used ${storage.reads - before} reads`);
	for (const index of [127, 0, 64, 2, 126, 1]) {
		const run = stored.inserts[index]!;
		assert.equal(run.lines[0], files[run.file]!.trimEnd());
	}
	assert.equal([...jsonValueChunks(stored)].join(""), expected);
});

test("chunk-backed JSON strings preserve escaping and split UTF-16 exactly", () => {
	const values = [
		"",
		"ordinary",
		'"\\\n\r\t\u0000',
		"\ud800",
		"\udc00",
		"\ud800\udc00",
		"a\ud800b\udc00c",
		"x".repeat(50000),
	];
	for (const text of values)
		for (const size of [1, 2, 17, 16384]) {
			const value = new JsonStringChunks(function* () {
				yield "";
				for (let offset = 0; offset < text.length; offset += size) {
					yield text.slice(offset, offset + size);
					yield "";
				}
			});
			assert.equal([...jsonValueChunks({ value })].join(""), JSON.stringify({ value: text }));
			assert.equal(JSON.stringify(value), JSON.stringify(text));
		}
});

test("registered lazy values stream without invoking their whole-value toJSON", () => {
	const value = {
		toJSON() {
			throw Error("whole value forbidden");
		},
	};
	registerJsonChunkValue(value, () => ({ lines: [new JsonStringChunks(() => ["abc", "def"])] }));
	assert.equal([...jsonValueChunks(value)].join(""), '{"lines":["abcdef"]}');
	assert.throws(() => [...jsonValueChunks(new JsonStringChunks(() => ["x".repeat(16385)]))], /exceeds bound/);
});

for (const length of [60000, 100000])
	test(`stored atom JSON streams a ${length}-character line without whole reads`, (t) => {
		const storage = new SqlState();
		t.after(() => storage.db.close());
		const graph = new Graph({ storage });
		const atom = buildBase({ f: `${"x".repeat(length)}\n` }, { author: "writer", message: "init" });
		graph.add(atom);
		const stored = graph.atom("a0");
		const expected = JSON.stringify(stored);
		t.mock.method(StoredText.prototype, "read", () => {
			throw Error("whole stored text forbidden");
		});
		assert.equal([...jsonValueChunks(stored)].join(""), expected);
	});
