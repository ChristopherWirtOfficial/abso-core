import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk runtime restores unpublished files and preserves published history", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "restore", "restore");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "a.txt": "original\n", "b.txt": "kept\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const call = (op: string, body: unknown) =>
		runtime().write(
			(c) => answer(c, op, "alice", body),
			() => {},
		);
	assert.equal(call("record", { files: { "a.txt": "changed\n", "b.txt": "different\n" } }).status, 200);
	const result = call("restore", { all: true });
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.deepEqual((result.body as { files: unknown }).files, { "a.txt": "original\n", "b.txt": "kept\n" });
	assert.deepEqual(
		runtime().read(
			(c) => c.shared().files,
			() => {},
		),
		{ "a.txt": "original\n", "b.txt": "kept\n" },
	);
});

for (const queued of [false, true]) {
	test(`disk restore preserves ${queued ? "queued" : "untargeted"} edits`, (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const runtime = () => new DiskFirstRuntime(storage, "partial", "partial");
		runtime().initialize(
			(c) =>
				answer(c, "init", undefined, {
					files: { "avcs.json": JSON.stringify({ queue: queued }), "a.txt": "original\n", "b.txt": "original b\n" },
				}),
			() => {},
		);
		while (!runtime().preparePage(() => {}).ready) {}
		const call = (op: string, body: unknown) =>
			runtime().write(
				(c) => {
					c.setCheckerReady(true);
					return answer(c, op, "alice", body);
				},
				() => {},
			);
		assert.equal(call("record", { files: { "b.txt": "preserved\n" } }).status, 200);
		if (queued) {
			const published = call("publish", { message: "queued work" });
			assert.equal(published.status, 200, JSON.stringify(published));
			assert.equal((published.body as { queued?: number }).queued, 1);
		}
		assert.equal(call("record", { files: { "a.txt": "discard me\n" } }).status, 200);
		const restored = call("restore", queued ? { all: true } : { files: ["a.txt"] });
		assert.equal(restored.status, 200, JSON.stringify(restored));
		assert.deepEqual((restored.body as { files: unknown }).files, { "a.txt": "original\n" });
		const synced = call("sync", {});
		assert.equal(synced.status, 200, JSON.stringify(synced));
		assert.equal((synced.body as { files: Record<string, string> }).files["b.txt"], "preserved\n");
	});
}
