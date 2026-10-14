import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { pushSnapshot } from "../src/push-snapshot.ts";
import { memoryStorage } from "./helpers.ts";

test("push snapshot reads a pinned version through fresh disk scopes after another publish", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const seed = new MemoryStore();
	new Project(seed).init({ "a.txt": "old\n", "b.txt": "stable\n" }, 0);
	new SqliteLog(storage).append(seed.entries);
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const runtime = () => new DiskFirstRuntime(storage, "push-snapshot", "push-snapshot");
	while (!runtime().preparePage(() => {}).ready) {}
	let reads = 0;
	const snapshot = pushSnapshot(
		runtime().read(
			(calls) => calls.sharedPushMetadata(),
			() => {},
		),
		(version, path) => {
			reads++;
			return runtime().read(
				(current) => current.fileTextAt(version, path),
				() => {},
			);
		},
		(version, paths) => {
			reads++;
			return runtime().read(
				(current) => current.fileTextsAt(version, paths),
				() => {},
			);
		},
	);
	assert.equal(reads, 0);
	assert.equal(snapshot.files["a.txt"], "old\n");
	for (const [op, body] of [
		["sync", {}],
		["record", { files: { "a.txt": "new", "b.txt": "changed" } }],
		["publish", { message: "Changed during push" }],
	] as const)
		assert.equal(
			runtime().write(
				(calls) => answer(calls, op, "alice", body),
				() => {},
			).status,
			200,
		);
	assert.equal(snapshot.files["b.txt"], "stable\n");
	assert.equal(snapshot.files["a.txt"], "old\n");
	assert.equal(snapshot.version, 0);
	assert.equal(reads, 2);
	assert.equal(
		runtime().read(
			(calls) => calls.shared().version,
			() => {},
		),
		1,
	);
});
