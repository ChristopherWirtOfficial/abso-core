import assert from "node:assert/strict";
import { test } from "node:test";
import { SqlState } from "../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import type { Entry } from "../../worker/project/project-types.ts";
import { StoredJson, storeJson } from "../src/stored-json.ts";
import { storedJsonView } from "../src/stored-json-view.ts";

test("Project adopts disk-backed decoded entries with replay parity and source fencing", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const log = new MemoryStore();
	const oracle = new Project(log);
	oracle.init({ "a.txt": "old\n" }, 0);
	oracle.record("alice", { "a.txt": "new\n" }, 1);
	oracle.publish("alice", "edit", 2);
	const source = { generation: 1, logLength: log.entries.length, sharedVersion: oracle.version };
	const frames = log.entries.map((entry, seq) => {
		const json = JSON.stringify(entry);
		const namespace = `decoded:${seq}`;
		storeJson(
			storage,
			namespace,
			(function* () {
				for (let i = 0; i < json.length; i += 11) yield json.slice(i, i + 11);
			})(),
		);
		return { seq, bytes: Buffer.byteLength(json), entry: storedJsonView(new StoredJson(storage, namespace)) as Entry };
	});
	const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
	let checks = 0;
	assert.throws(
		() =>
			Project.adoptWriterPage(storage, {
				source,
				from: 0,
				frames,
				maxEntries: 32,
				maxBytes: 100000,
				currentSource: () => (++checks === 1 ? source : { ...source, generation: 2 }),
			}),
		/source changed during/,
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
	t.mock.method(Project, "load", () => {
		throw Error("full history load forbidden");
	});
	assert.equal(
		Project.adoptWriterPage(storage, {
			source,
			from: 0,
			frames,
			maxEntries: 32,
			maxBytes: 100000,
			currentSource: () => source,
		}).ready,
		true,
	);
	const reopened = Project.openWriter(log, storage, log.entries.length);
	assert.deepEqual(reopened.files(), oracle.files());
	assert.deepEqual(reopened.status(), oracle.status());
});
