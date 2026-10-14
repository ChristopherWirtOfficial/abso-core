import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("streamed writer adoption accepts a canonical frame above the full-decoder ceiling", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	new Project(memory).init({ "large.txt": "x".repeat(8100000) }, 0);
	const log = new SqliteLog(storage);
	log.append(memory.entries);
	SqliteWriterState.initialize(storage);
	const host = new SqliteWriterHost(storage, "large-stream");
	const expected = host.source();
	t.mock.method(SqliteLog.prototype, "boundedFrame", () => {
		throw Error("whole frame forbidden");
	});
	t.mock.method(Project, "load", () => {
		throw Error("whole history forbidden");
	});
	const maxBytes = log.adoptionPageBytes(0);
	assert.ok(maxBytes > 8000000);
	const page = host.adoptVerifiedPage({ expected, from: 0, digest: "", maxEntries: 1, maxBytes }, () => {});
	assert.equal(page.ready, true);
	assert.equal(host.root().logLength, 1);
	assert.ok(JSON.stringify(new SqliteWriterState(storage, "large-stream").read("atoms", "0")).length < 4096);
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace='large-stream:decoded'").get()!.n,
		0,
	);
});
