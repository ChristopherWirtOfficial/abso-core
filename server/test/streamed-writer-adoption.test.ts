import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("writer adoption streams canonical frames and preserves exact page retries", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const oracle = new Project(memory);
	oracle.init({ "a.txt": "one\n" }, 0);
	oracle.record("alice", { "a.txt": "two\n" }, 1);
	oracle.publish("alice", "change", 2);
	new SqliteLog(storage).append(memory.entries);
	SqliteWriterState.initialize(storage);
	const host = () => new SqliteWriterHost(storage, "streamed-writer");
	const expected = host().source();
	const canonical = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	t.mock.method(SqliteLog.prototype, "boundedFrame", () => {
		throw Error("whole frame reconstruction forbidden");
	});
	t.mock.method(Project, "load", () => {
		throw Error("full history forbidden");
	});
	let from = 0,
		digest = "";
	while (from < expected.logLength) {
		const input = { expected, from, digest, maxEntries: 2, maxBytes: 100000 };
		const page = host().adoptVerifiedPage(input, () => {});
		assert.deepEqual(
			host().adoptVerifiedPage(input, () => {}),
			page,
		);
		from = page.next;
		digest = page.digest;
	}
	assert.deepEqual(
		host().readCalls({ expected, validateAuthority: () => {}, operation: (calls) => calls.shared().files }),
		oracle.files(),
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), canonical);
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace='streamed-writer:decoded'").get()!.n,
		0,
	);
});
