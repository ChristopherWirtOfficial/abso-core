import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../../src/engine/graph.ts";
import { answer } from "../../worker/project/http.ts";
import { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteHistoryState } from "../src/history-state.ts";
import { memoryStorage } from "./helpers.ts";

test("large atom lists preserve historical reads after later writes", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "list-history", "list-history");
	const old = Array.from({ length: 300 }, (_, i) => `old line ${i}`).join("\n") + "\n";
	const current = Array.from({ length: 300 }, (_, i) => `new line ${i}`).join("\n") + "\n";
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": old } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const before = runtime().read(
		(calls) => calls.fileAt("a.txt", 0, null),
		() => {},
	);
	assert.equal(
		runtime().write(
			(calls) => answer(calls, "record", "alice", { files: { "a.txt": current } }),
			() => {},
		).status,
		200,
	);
	assert.equal(
		runtime().write(
			(calls) => answer(calls, "publish", "alice", { message: "Replace all lines" }),
			() => {},
		).status,
		200,
	);
	t.mock.method(Project, "load", () => {
		throw Error("full history replay forbidden");
	});
	assert.deepEqual(
		runtime().read(
			(calls) => calls.fileAt("a.txt", 0, null),
			() => {},
		),
		before,
	);
	assert.equal(
		runtime().read(
			(calls) => calls.shared().files["a.txt"],
			() => {},
		),
		current,
	);
	assert.ok(
		(storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE collection LIKE 'atom-list:%'").get()!
			.n as number) > 0,
	);
	const history = new SqliteHistoryState(storage, "list-history:history", new SqliteLog(storage).seq());
	const graph = new Graph({ storage: history.at(1, () => {}) });
	assert.equal(graph.lineText("a0.0"), "old line 0");
	assert.equal(graph.atom("a0").inserts[0]!.lines[0], "old line 0");
});
