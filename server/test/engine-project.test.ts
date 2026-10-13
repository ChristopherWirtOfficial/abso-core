import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { EngineProject, SqliteLog } from "../src/engine-project.ts";
import { memoryStorage } from "./helpers.ts";

describe("the engine over the object's SQLite log", () => {
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
