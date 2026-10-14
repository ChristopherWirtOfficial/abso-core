import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../../src/engine/graph.ts";
import { StoredText } from "../../src/engine/stored-text.ts";
import { answer } from "../../worker/project/http.ts";
import { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteHistoryState } from "../src/history-state.ts";
import { memoryStorage } from "./helpers.ts";

test("long text remains exact in current and historical storage after later writes", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "long-history", "long-history");
	const old = `${"old".repeat(20000)}\uD83D\uDE00\n`;
	const current = `${"new".repeat(20000)}\uD834\uDD1E\n`;
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": old } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const before = runtime().read(
		(calls) => calls.fileAt("a.txt", 0, null),
		() => {},
	);
	const wholeRead = t.mock.method(StoredText.prototype, "read", () => {
		throw Error("whole stored text read forbidden during record");
	});
	assert.equal(
		runtime().write(
			(calls) => answer(calls, "record", "alice", { files: { "a.txt": current } }),
			() => {},
		).status,
		200,
	);
	wholeRead.mock.restore();
	assert.equal(
		runtime().write(
			(calls) => answer(calls, "publish", "alice", { message: "Replace long line" }),
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
	const history = new SqliteHistoryState(storage, "long-history:history", new SqliteLog(storage).seq());
	const graph = new Graph({ storage: history.at(1, () => {}) });
	assert.equal(graph.lineText("a0.0"), old.slice(0, -1));
	assert.equal(graph.atom("a0").inserts[0]!.lines[0], old.slice(0, -1));
});
