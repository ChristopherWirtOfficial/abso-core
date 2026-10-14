import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk runtime reads the unpublished diff from indexed membership", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "diff", "diff");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "a.txt": "before\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	assert.equal(
		runtime().write(
			(c) => answer(c, "record", "alice", { files: { "a.txt": "after\n" } }),
			() => {},
		).status,
		200,
	);
	const result = runtime().write(
		(c) => answer(c, "diff", "alice", {}),
		() => {},
	);
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.deepEqual((result.body as { files: unknown }).files, [
		{ path: "a.txt", before: "before\n", after: "after\n" },
	]);
});
