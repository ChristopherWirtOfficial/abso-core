// A server writer's own storage holds long atom text in chunks (moved here from src/engine/test/graph-long-text.test.ts:
// the engine's tests stay free of server/, which the platform's pin on the tool doesn't carry).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../../src/engine/graph.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

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
