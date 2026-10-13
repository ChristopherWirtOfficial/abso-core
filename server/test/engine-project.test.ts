import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { EngineProject, SqliteLog } from "../src/engine-project.ts";
import { memoryStorage } from "./helpers.ts";

describe("the engine over the object's SQLite log", () => {
	it("extracts feed events without retaining a page of canonical payloads", (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const project = EngineProject.open(storage);
		answer(project, "init", undefined, { files: { "a.txt": "one\n" } });
		answer(project, "sync", "alice", {});
		answer(project, "record", "alice", { files: { "a.txt": "two\n" } });
		answer(project, "publish", "alice", { message: "Changed" });
		const expected = project.feed(0, 500);
		const original = SqliteLog.prototype.since;
		let reads = 0;
		t.mock.method(SqliteLog.prototype, "since", function (this: SqliteLog, from: number, limit: number) {
			assert.equal(limit, 1, "feed must release each canonical payload before reading another");
			reads++;
			return original.call(this, from, limit);
		});
		assert.deepEqual(project.feed(0, 500), expected);
		assert.equal(reads, expected.next);
		assert.deepEqual(project.feed(1, 2).events, expected.events.slice(1, 3));
	});
	it("serves init, records and pushes through answer(), and holds a collision", () => {
		const storage = memoryStorage();
		const p = EngineProject.open(storage);
		assert.equal(answer(p, "init", undefined, { files: { "a.txt": "one\ntwo\nthree\n" } }).status, 200);
		for (const agent of ["alice", "bob"]) assert.equal(answer(p, "sync", agent, {}).status, 200);
		answer(p, "record", "alice", { files: { "a.txt": "one\nTWO by alice\nthree\n" } });
		answer(p, "record", "bob", { files: { "a.txt": "one\ntwo by bob\nthree\n" } });
		const first = answer(p, "publish", "alice", { message: "Alice's two" });
		assert.deepEqual(first, { status: 200, body: { ok: true, version: 1, changes: 1 } });
		const second = answer(p, "publish", "bob", { message: "Bob's two" }).body as { ok: boolean; collisions: unknown[] };
		assert.equal(second.ok, false);
		assert.equal(second.collisions.length, 1);
	});

	it("loads the same project back from the log", () => {
		const storage = memoryStorage();
		const p = EngineProject.open(storage);
		answer(p, "init", undefined, { files: { "a.txt": "one\n" } });
		answer(p, "sync", "alice", {});
		answer(p, "record", "alice", { files: { "a.txt": "one\ntwo\n" } });
		answer(p, "publish", "alice", { message: "Add two" });
		const again = EngineProject.open(storage);
		assert.equal(again.shared().version, 1);
		assert.equal(again.shared().files["a.txt"], "one\ntwo\n");
		const log = new SqliteLog(storage);
		assert.equal(log.sharedVersion(), 1);
		assert.deepEqual(log.lastPublish()?.agent, "alice");
		assert.equal(log.logSize().entries, log.seq());
	});
});
