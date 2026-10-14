import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { EngineProject } from "../src/engine-project.ts";
import { pushSnapshot } from "../src/push-snapshot.ts";
import { memoryStorage } from "./helpers.ts";

test("push batches cap file count and text while preserving exact lazy contents", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const project = EngineProject.open(storage);
	const files = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`f${i}`, `${i}\n`]));
	assert.equal(answer(project, "init", undefined, { files }).status, 200);
	let batches = 0;
	const snapshot = pushSnapshot(
		project.sharedPushMetadata(),
		() => {
			throw Error("single read forbidden");
		},
		(version, paths) => {
			batches++;
			return project.fileTextsAt(version, paths);
		},
	);
	assert.equal(batches, 0);
	assert.deepEqual({ ...snapshot.files }, files);
	assert.equal(batches, 3);
	const large = "x".repeat(70000) + "\n";
	assert.equal(answer(project, "record", "writer", { files: { large } }).status, 200);
	assert.equal(answer(project, "publish", "writer", { message: "Large file" }).status, 200);
	const batch = project.fileTextsAt(1, ["large", "f0"]);
	assert.deepEqual(Object.keys(batch), ["large"]);
	assert.equal(batch.large, large);
});
