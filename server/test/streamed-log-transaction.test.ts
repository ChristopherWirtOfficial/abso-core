import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { logParts, SqliteLog } from "../src/engine-project.ts";
import { memoryStorage } from "./helpers.ts";

test("streamed append preserves exact rows and rolls back a partial frame on storage failure", (t) => {
	const memory = new MemoryStore();
	new Project(memory).init({ "large.txt": "😀".repeat(700000) }, 0);
	const expected = memory.entries.flatMap((entry, seq) =>
		logParts(JSON.stringify(entry)).map((text, part) => ({ seq, part, text })),
	);
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const log = new SqliteLog(storage);
	const beforeGeneration = log.generation();
	const exec = storage.sql.exec.bind(storage.sql);
	let inserts = 0;
	storage.sql.exec = (query, ...bindings) => {
		if (query.startsWith("INSERT INTO log") && ++inserts === 2) throw Error("injected row failure");
		return exec(query, ...bindings);
	};
	assert.throws(() => log.append(memory.entries), /injected row failure/);
	storage.sql.exec = exec;
	assert.deepEqual(storage.db.prepare("SELECT * FROM log").all(), []);
	assert.equal(log.generation(), beforeGeneration);
	log.append(memory.entries);
	const rows = storage.db.prepare("SELECT seq, part, text FROM log ORDER BY seq, part").all();
	assert.deepEqual(JSON.parse(JSON.stringify(rows)), expected);
	assert.equal(log.generation(), beforeGeneration + 1);
});
