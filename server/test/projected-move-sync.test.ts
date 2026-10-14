import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk runtime syncs overlapping edits after a published move", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "sync", "sync");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "a.txt": "one\ntwo\nthree\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const call = (op: string, agent: string, body: unknown) =>
		runtime().write(
			(c) => answer(c, op, agent, body),
			() => {},
		);
	assert.equal(call("move", "alice", { from: "a.txt", to: "b.txt" }).status, 200);
	assert.equal(call("publish", "alice", { message: "Move" }).status, 200);
	for (const agent of ["alice", "bob"]) assert.equal(call("sync", agent, {}).status, 200);
	assert.equal(call("record", "alice", { files: { "b.txt": "one\nalice\nthree\n" } }).status, 200);
	assert.equal(call("record", "bob", { files: { "b.txt": "one\nbob\nthree\n" } }).status, 200);
	assert.equal(call("publish", "alice", { message: "alice" }).status, 200);
	const result = {
		status: 200,
		body: runtime().write(
			(c) => c.sync("bob"),
			() => {},
		),
	};
	assert.equal(result.status, 200, JSON.stringify(result));
	const body = result.body as {
		version: number;
		files: Record<string, string>;
		collisions: { kind: string; marked?: boolean }[];
	};
	assert.equal(body.version, 2);
	assert.equal(body.collisions.length, 1);
	assert.equal(body.collisions[0]!.kind, "lines");
	assert.equal(body.collisions[0]!.marked, true);
	assert.match(body.files["b.txt"]!, /<<<<<<< yours/);
	assert.match(body.files["b.txt"]!, /bob/);
	assert.match(body.files["b.txt"]!, /alice/);
	const repeated = call("sync", "bob", {});
	assert.equal(repeated.status, 200);
	assert.equal((repeated.body as typeof body).collisions.length, 1);
	assert.equal((repeated.body as typeof body).collisions[0]!.marked, true);
});
