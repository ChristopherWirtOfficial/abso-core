import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../../worker/project/project.ts";
import { Graph } from "../graph.ts";
import { SqlState } from "./storage-helper.ts";

test("large insertion text stays lazy even when the run has few lines", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const line = "x".repeat(100000);
	new Project(memory).init({ "a.txt": `${line}\n${line}\n${line}\n` }, 0);
	const entry = memory.entries[0]!;
	if (entry.type !== "init") throw Error("expected init");
	new Graph({ storage }).add(entry.atom);
	const read = storage.read.bind(storage);
	let textReads = 0;
	t.mock.method(storage, "read", (collection: string, key: string) => {
		if (collection === "atom-text:long:chunks") textReads++;
		return read(collection, key);
	});
	const atom = new Graph({ storage }).atom("a0");
	assert.equal(atom.inserts[0]!.lines.length, 3);
	assert.equal(textReads, 0, "reading line count must not decode the complete run");
	assert.equal(atom.inserts[0]!.lines[1], line);
	assert.equal(textReads, Math.ceil(line.length / 16384), "an indexed read decodes only the selected line");
});

test("persistent graph stores long lines in chunks and reopens exact text", () => {
	const storage = new SqlState();
	try {
		const memory = new MemoryStore();
		const value = `${"x".repeat(100000)}\uD83D\uDE00`;
		new Project(memory).init({ "a.txt": value }, 0);
		const entry = memory.entries[0]!;
		assert.equal(entry.type, "init");
		if (entry.type !== "init") throw Error("expected init");
		new Graph({ storage }).add(entry.atom);
		assert.deepEqual(storage.read("line-text", "0"), { format: 1, text: JSON.stringify(["0", 0]) });
		assert.equal(new Graph({ storage }).lineText("a0.0"), value);
		assert.ok(
			(storage.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection = 'atom-text:long:chunks'").get()!
				.n as number) > 1,
		);
	} finally {
		storage.db.close();
	}
});

import { SqliteWriterState } from "../../../server/src/writer-host.ts";
import { memoryStorage } from "../../../server/test/helpers.ts";

test("persistent atom metadata accepts text beyond the generic state limit", (t) => {
	const database = memoryStorage();
	t.after(() => database.db.close());
	SqliteWriterState.initialize(database);
	const storage = new SqliteWriterState(database, "long-atom");
	const memory = new MemoryStore();
	const value = "x".repeat(8100000);
	new Project(memory).init({ "large.txt": value }, 0);
	const entry = memory.entries[0]!;
	if (entry.type !== "init") throw Error("expected init");
	new Graph({ storage }).add(entry.atom);
	assert.ok(JSON.stringify(storage.read("atoms", "0")).length < 4096);
	const read = storage.read.bind(storage);
	let textReads = 0;
	t.mock.method(storage, "read", (collection: string, key: string) => {
		if (collection === "atom-text:long:chunks") textReads++;
		return read(collection, key);
	});
	const graph = new Graph({ storage });
	const atom = graph.atom("a0");
	assert.equal(textReads, 0, "reading atom metadata must not load long text");
	assert.equal(atom.inserts[0]!.lines[0], value);
	assert.ok(textReads > 0);
	assert.equal(graph.lineText("a0.0"), value);
	assert.equal(
		database.db
			.prepare(
				"SELECT COUNT(*) AS n FROM writer_state WHERE namespace = 'long-atom' AND collection = 'atom-text:long:chunks' AND part = -1",
			)
			.get()!.n,
		Math.ceil(value.length / 16384),
	);
	assert.equal(
		database.db
			.prepare(
				"SELECT COUNT(*) AS n FROM writer_state WHERE namespace = 'long-atom' AND collection = 'line-text:long:chunks'",
			)
			.get()!.n,
		0,
	);
});

test("long atom acceptance rolls back partial chunks and detects missing text", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const value = "z".repeat(100000);
	new Project(memory).init({ "a.txt": value }, 0);
	const entry = memory.entries[0]!;
	if (entry.type !== "init") throw Error("expected init");
	const graph = new Graph({ storage });
	const rows = () => storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	const before = rows();
	const write = storage.write.bind(storage);
	let chunks = 0;
	const failure = t.mock.method(storage, "write", (collection: string, key: string, value: unknown) => {
		write(collection, key, value);
		if (collection === "atom-text:long:chunks" && ++chunks === 2) throw Error("injected partial atom text");
	});
	assert.throws(() => graph.add(entry.atom), /partial atom text/);
	assert.deepEqual(rows(), before);
	assert.equal(graph.size, 0);
	failure.mock.restore();
	graph.add(entry.atom);
	assert.equal(graph.lineText("a0.0"), value);
	const textKey = JSON.stringify(["0", 0]);
	storage.remove("atom-text:long:chunks", JSON.stringify([textKey, 1]));
	const reopened = new Graph({ storage });
	assert.throws(() => reopened.lineText("a0.0"), /incomplete stored text/);
	assert.throws(() => reopened.atom("a0").inserts[0]!.lines[0], /incomplete stored text/);
});

test("persistent graph detaches accepted lists without freezing a second input copy", () => {
	const storage = new SqlState();
	try {
		const memory = new MemoryStore();
		new Project(memory).init({ "a.txt": "before\nsecond" }, 0);
		const entry = memory.entries[0]!;
		if (entry.type !== "init") throw Error("expected init");
		const atom = structuredClone(entry.atom);
		const expected = structuredClone(atom);
		const graph = new Graph({ storage });
		graph.add(atom);
		(atom.inserts[0]!.lines as string[])[0] = "changed";
		(atom.writes as string[]).length = 0;
		for (const loaded of [graph, new Graph({ storage })]) {
			assert.deepEqual(JSON.parse(JSON.stringify(loaded.atom("a0"))), expected);
			assert.equal(loaded.lineText("a0.0"), expected.inserts[0]!.lines[0]);
		}
	} finally {
		storage.db.close();
	}
});
