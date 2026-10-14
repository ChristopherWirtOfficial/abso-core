import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { memoryStorage } from "./helpers.ts";

test("scratch-backed definition scanning preserves code-file record and publish", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "text-bound", "text-bound");
	const unchanged = "stable".repeat(10000);
	const old = `${"old".repeat(20000)}\n${unchanged}\n`;
	const current = `changed\n${unchanged}\n`;
	assert.equal(
		runtime().initialize(
			(c) => answer(c, "init", undefined, { files: { f: old } }),
			() => {},
		).status,
		200,
	);
	while (!runtime().preparePage(() => {}).ready) {}
	t.mock.method(Project, "load", () => {
		throw Error("full history replay forbidden");
	});

	assert.equal(
		runtime().write(
			(c) => answer(c, "record", "writer", { files: { f: current } }),
			() => {},
		).status,
		200,
	);
	assert.equal(
		runtime().write(
			(c) => answer(c, "publish", "writer", { message: "replace" }),
			() => {},
		).status,
		200,
	);
	assert.equal(
		runtime().read(
			(c) => c.filesAt(0)["f"],
			() => {},
		),
		old,
	);
	assert.equal(
		runtime().read(
			(c) => c.shared().files["f"],
			() => {},
		),
		current,
	);
});
