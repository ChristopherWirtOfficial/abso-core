import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { EngineProject } from "../src/engine-project.ts";
import { memoryStorage } from "./helpers.ts";

test("tree and path history after a move match memory without persistent read writes", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = EngineProject.open(storage);
	assert.equal(answer(memory, "init", undefined, { files: { "a.txt": "one\ntwo\n" } }).status, 200);
	assert.equal(answer(memory, "move", "alice", { from: "a.txt", to: "b.txt" }).status, 200);
	assert.equal(answer(memory, "publish", "alice", { message: "Move" }).status, 200);
	const requests = [
		["tree", {}],
		["tree", { version: 0 }],
		["path", { path: "a.txt" }],
		["path", { path: "b.txt" }],
	] as const;
	const expected = requests.map(([op, body]) => answer(memory, op, "alice", body));
	for (const result of expected) assert.equal(result.status, 200, JSON.stringify(result));
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const runtime = () => new DiskFirstRuntime(storage, "path-history", "path-history");
	while (!runtime().preparePage(() => {}).ready) {}
	const rows = () => storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all();
	const before = rows();
	for (let i = 0; i < requests.length; i++) {
		const [op, body] = requests[i]!;
		assert.deepEqual(
			runtime().read(
				(calls) => answer(calls, op, "alice", body),
				() => {},
			),
			expected[i],
		);
	}
	assert.deepEqual(rows(), before);
});
