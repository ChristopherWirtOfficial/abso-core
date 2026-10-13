import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { Project } from "../../worker/project/project.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { memoryStorage } from "./helpers.ts";

test("runtime resumes from disk and detaches reads, with exact authorized retries", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "abso-runtime-"));
	const filename = join(directory, "state.sqlite");
	let storage = memoryStorage(filename);
	t.after(() => {
		storage.db.close();
		unlinkSync(filename);
		rmdirSync(directory);
	});
	const runtime = () => new DiskFirstRuntime(storage, "project-1", "disk-v1");
	const validate = () => {};
	t.mock.method(Project, "load", () => {
		throw Error("full-history load forbidden");
	});
	assert.equal(runtime().preparePage(validate).phase, "empty");
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'writer_state'").get()!.n,
		0,
		"an empty lookup must not install the legacy-write fence",
	);
	assert.equal(
		runtime().initialize((calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\ntwo\n" } }), validate)
			.status,
		200,
	);
	assert.throws(() => runtime().write(() => undefined, validate), /not complete/);
	let pages = 0;
	while (!runtime().preparePage(validate).ready) {
		assert.ok(++pages < 100);
		storage.db.close();
		storage = memoryStorage(filename);
	}
	assert.ok(pages > 0);
	const req = { id: "record-1", identity: { agent: "alice", operation: "record", files: { "a.txt": "changed\n" } } };
	const operation = (calls: Parameters<Parameters<DiskFirstRuntime["write"]>[0]>[0]) =>
		answer(calls, "record", "alice", { files: req.identity.files });
	const first = runtime().write(operation, validate, req);
	assert.equal(first.status, 200);
	const length = new SqliteLog(storage).seq();
	storage.db.close();
	storage = memoryStorage(filename);
	assert.deepEqual(
		runtime().write(
			() => {
				throw Error("retry executed");
			},
			validate,
			req,
		),
		first,
	);
	assert.equal(new SqliteLog(storage).seq(), length);
	assert.throws(() => runtime().write(operation, validate, { ...req, identity: { agent: "bob" } }), /reused/);
	assert.throws(
		() =>
			runtime().write(
				operation,
				() => {
					throw Error("revoked");
				},
				req,
			),
		/revoked/,
	);
	assert.equal(
		runtime().write((calls) => answer(calls, "publish", "alice", { message: "Publish" }), validate).status,
		200,
	);
	const shared = runtime().read((calls) => calls.shared(), validate);
	assert.equal(Object.getOwnPropertyDescriptor(shared, "files")?.get, undefined);
	assert.equal(shared.files["a.txt"], "changed\n");
	storage.db.close();
	storage = memoryStorage(filename);
	assert.equal(runtime().preparePage(validate).ready, true);
	assert.equal(
		runtime().read((calls) => calls.shared().files["a.txt"], validate),
		"changed\n",
	);
});

test("runtime page and write authority failures leave no partial state", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = new DiskFirstRuntime(storage, "project", "disk-v1");
	runtime.initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	const rows = () => {
		const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
		return tables.map((row) => [
			row.name,
			storage.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all(),
		]);
	};
	const before = rows();
	let checks = 0;
	assert.throws(
		() =>
			runtime.preparePage(() => {
				if (++checks === 3) throw Error("authority changed");
			}),
		/authority changed/,
	);
	assert.deepEqual(rows(), before);
	while (!runtime.preparePage(() => {}).ready) {}
	const adopted = rows();
	checks = 0;
	assert.throws(
		() =>
			runtime.write(
				(calls) => answer(calls, "record", "alice", { files: { "a.txt": "two\n" } }),
				() => {
					if (++checks === 3) throw Error("authority changed");
				},
				{ id: "failed", identity: "record" },
			),
		/authority changed/,
	);
	assert.deepEqual(rows(), adopted);
});
