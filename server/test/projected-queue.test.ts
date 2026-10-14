import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import type { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk queue preserves a dropped base without restoring dropped changes", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "queue-drop", "queue-drop");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "avcs.json": '{"queue":true}', "a.txt": "before\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	runtime().write(
		(c) => {
			assert.equal(answer(c, "record", "alice", { files: { "a.txt": "temporary\n" } }).status, 200);
			assert.equal(answer(c, "publish", "alice", { message: "Temporary" }).status, 200);
			c.sync("old");
			assert.equal(c.drop("alice", [1], "Undo temporary").ok, true);
		},
		() => {},
	);
	for (const [agent, file] of [
		["ahead", "ahead.txt"],
		["old", "old.txt"],
	] as const) {
		runtime().write(
			(c) => {
				c.setCheckerReady(true);
				assert.equal(answer(c, "record", agent, { files: { [file]: `${agent}\n` } }).status, 200);
				const result = answer(c, "publish", agent, { message: agent });
				assert.equal(result.status, 200, JSON.stringify(result));
				assert.equal((result.body as { queued: number }).queued, agent === "ahead" ? 1 : 2);
			},
			() => {},
		);
	}
	const candidate = runtime().read(
		(c) => (c as unknown as { project: Project }).project.queueCandidate(2),
		() => {},
	);
	assert.equal(candidate.files["a.txt"], "before\n");
	assert.equal(candidate.files["ahead.txt"], "ahead\n");
	assert.equal(candidate.files["old.txt"], "old\n");
});

test("disk runtime builds and lands a queued candidate", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "queue", "queue");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "avcs.json": '{"queue":true}', "a.txt": "before\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	runtime().write(
		(c) => {
			c.setCheckerReady(true);
			assert.equal(answer(c, "record", "alice", { files: { "a.txt": "after\n" } }).status, 200);
			const result = answer(c, "publish", "alice", { message: "Queued" });
			assert.equal((result.body as { queued: number }).queued, 1);
		},
		() => {},
	);
	// Queue-driver methods are internal to the Project adapter, not public HTTP commands.
	const candidate = runtime().read(
		(c) => (c as unknown as { project: Project }).project.queueCandidate(1),
		() => {},
	);
	assert.equal(candidate.files["a.txt"], "after\n");
	const landed = runtime().write(
		(c) => (c as unknown as { project: Project }).project.queueLand(1, 10),
		() => {},
	);
	assert.deepEqual(landed.versions, [{ id: 1, version: 1 }]);
	const empty = runtime().read(
		(c) => (c as unknown as { project: Project }).project.queueCandidate(4),
		() => {},
	);
	assert.deepEqual(empty.ids, []);
	assert.deepEqual(empty.files, candidate.files);
	assert.equal(empty.tree, candidate.tree);
	assert.equal(
		runtime().read(
			(c) => c.shared().files["a.txt"],
			() => {},
		),
		"after\n",
	);
});

test("disk runtime builds and lands two queued candidates in order", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "queue", "queue");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "avcs.json": '{"queue":true}', "a.txt": "before\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	runtime().write(
		(c) => {
			c.setCheckerReady(true);
			assert.equal(answer(c, "record", "alice", { files: { "a.txt": "after\n" } }).status, 200);
			const result = answer(c, "publish", "alice", { message: "Queued" });
			assert.equal((result.body as { queued: number }).queued, 1);
		},
		() => {},
	);
	runtime().write(
		(c) => {
			c.setCheckerReady(true);
			assert.equal(answer(c, "record", "bob", { files: { "b.txt": "second\n" } }).status, 200);
			const result = answer(c, "publish", "bob", { message: "Second" });
			assert.equal(result.status, 200, JSON.stringify(result));
			assert.equal((result.body as { queued: number }).queued, 2);
		},
		() => {},
	);
	// Queue-driver methods are internal to the Project adapter, not public HTTP commands.
	const candidate = runtime().read(
		(c) => (c as unknown as { project: Project }).project.queueCandidate(2),
		() => {},
	);
	assert.equal(candidate.files["a.txt"], "after\n");
	assert.equal(candidate.files["b.txt"], "second\n");
	const landed = runtime().write(
		(c) => (c as unknown as { project: Project }).project.queueLand(2, 10),
		() => {},
	);
	assert.deepEqual(landed.versions, [
		{ id: 1, version: 1 },
		{ id: 2, version: 2 },
	]);
	assert.equal(
		runtime().read(
			(c) => c.shared().files["a.txt"],
			() => {},
		),
		"after\n",
	);
});

test("disk queue refuses overlapping edits and accepts an older nonconflicting base", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "queue-edge", "queue-edge");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "avcs.json": '{"queue":true}', "a.txt": "before\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const call = (op: string, agent: string, body: unknown) =>
		runtime().write(
			(c) => {
				c.setCheckerReady(true);
				return answer(c, op, agent, body);
			},
			() => {},
		);
	for (const agent of ["alice", "bob", "old"]) assert.equal(call("sync", agent, {}).status, 200);
	assert.equal(call("record", "alice", { files: { "a.txt": "alice\n" } }).status, 200);
	assert.equal((call("publish", "alice", { message: "Alice" }).body as { queued: number }).queued, 1);
	assert.equal(call("record", "bob", { files: { "a.txt": "bob\n" } }).status, 200);
	const refused = call("publish", "bob", { message: "Bob conflict" });
	assert.equal(refused.status, 200, JSON.stringify(refused));
	assert.equal((refused.body as { ok: boolean }).ok, false);
	assert.ok((refused.body as { collisions: unknown[] }).collisions.length > 0);
	runtime().write(
		(c) => (c as unknown as { project: Project }).project.queueLand(1, 20),
		() => {},
	);
	assert.equal(call("record", "alice", { files: { "next.txt": "next\n" } }).status, 200);
	assert.equal((call("publish", "alice", { message: "Next" }).body as { queued: number }).queued, 2);
	assert.equal(call("record", "old", { files: { "old.txt": "old base\n" } }).status, 200);
	const queued = call("publish", "old", { message: "Old base" });
	assert.equal(queued.status, 200, JSON.stringify(queued));
	assert.equal((queued.body as { queued: number }).queued, 3);
	const candidate = runtime().read(
		(c) => (c as unknown as { project: Project }).project.queueCandidate(2),
		() => {},
	);
	assert.equal(candidate.files["a.txt"], "alice\n");
	assert.equal(candidate.files["next.txt"], "next\n");
	assert.equal(candidate.files["old.txt"], "old base\n");
});
