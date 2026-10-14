import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk runtime compares published versions through indexed views", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "compare", "compare");
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
	assert.equal(
		runtime().write(
			(c) => answer(c, "publish", "alice", { message: "change" }),
			() => {},
		).status,
		200,
	);
	const result = runtime().read(
		(c) => answer(c, "compare", undefined, { from: 0, to: 1 }),
		() => {},
	);
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.equal((result.body as { files: unknown[] }).files.length, 1);
});
