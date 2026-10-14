import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("disk runtime moves a text file without using a stale reader", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "move", "move");
	runtime().initialize(
		(c) => answer(c, "init", undefined, { files: { "a.txt": "one\ntwo\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const result = runtime().write(
		(c) => answer(c, "move", "alice", { from: "a.txt", to: "b.txt" }),
		() => {},
	);
	assert.equal(result.status, 200, JSON.stringify(result));
	assert.equal(
		runtime().write(
			(c) => answer(c, "publish", "alice", { message: "move" }),
			() => {},
		).status,
		200,
	);
	assert.deepEqual(
		runtime().read(
			(c) => c.shared().files,
			() => {},
		),
		{ "b.txt": "one\ntwo\n" },
	);
});
