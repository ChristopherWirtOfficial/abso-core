import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteProjectionStore } from "../src/projection-store.ts";
import { SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("open server adopts and records through its call adapter without full-history loading", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "abso-core-writer-"));
	const filename = join(directory, "state.sqlite");
	let storage = memoryStorage(filename);
	const reopen = () => {
		storage.db.close();
		storage = memoryStorage(filename);
	};
	t.after(() => {
		storage.db.close();
		unlinkSync(filename);
		rmdirSync(directory);
	});
	const memory = new MemoryStore();
	const oracle = new Project(memory);
	oracle.init({ "a.txt": "one\ntwo\n" }, 0);
	oracle.record("alice", { "a.txt": "ONE\ntwo\n" }, 1);
	oracle.publish("alice", "First", 2);
	oracle.move("alice", "a.txt", "b.txt", 3);
	oracle.publish("alice", "Move", 4);
	new SqliteLog(storage).append(memory.entries);
	SqliteWriterState.initialize(storage);
	const namespace = "open-server-capacity";
	const host = () => new SqliteWriterHost(storage, namespace, undefined, { indexProjectionAtoms: true });
	const expected = host().source();
	const canonicalBefore = storage.db.prepare("SELECT * FROM log ORDER BY seq, part").all();
	t.mock.method(Project, "load", () => {
		throw Error("full-history loading forbidden");
	});
	let from = 0,
		digest = "",
		ready = false;
	while (!ready) {
		const page = host().adoptVerifiedPage({ expected, from, digest, maxEntries: 2, maxBytes: 16384 }, () => {});
		assert.deepEqual(
			host().adoptVerifiedPage({ expected, from, digest, maxEntries: 2, maxBytes: 16384 }, () => {}),
			page,
		);
		from = page.next;
		digest = page.digest;
		ready = page.ready;
		reopen();
	}
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq, part").all(), canonicalBefore);
	let state = new SqliteWriterState(storage, namespace);
	const projection = new SqliteProjectionStore(
		{ database: "project", namespace: "views", registry: "roots", defaultFile: "a.txt" },
		1,
		{ indexedAtoms: true },
	);
	let pages = 0;
	while (
		!projection.adopt({
			state,
			expected: host().root(),
			currentRoot: () => host().root(),
			maxAtoms: 1,
			maxVersions: 1,
			maxSteps: 2,
		}).ready
	)
		assert.ok(++pages < 1000);
	// Repeated anonymous views share one reader only inside their verified session.
	const session = projection.open({ state, log: new SqliteLog(storage), root: host().root() });
	const views = session.readViewProvider(oracle.graph);
	const first = views.keyed!("v @0");
	assert.equal(views.keyed!("v @0"), first);
	assert.deepEqual(first.files(), { "a.txt": "one\ntwo\n" });
	const seq = oracle.graph.size;
	oracle.graph.add({
		id: `a${seq}`,
		seq,
		author: "fixture",
		message: "Advance graph",
		time: 5,
		inserts: [],
		deletes: [],
		writes: [],
		reads: [],
		holds: [],
		needs: [],
		resolves: [],
		reasons: [],
		deps: ["a0"],
	});
	assert.throws(() => first.files(), /stale/);
	const refreshed = views.keyed!("v @0");
	assert.notEqual(refreshed, first);
	assert.deepEqual(refreshed.files(), { "a.txt": "one\ntwo\n" });
	session.close();
	assert.throws(() => refreshed.files(), /expired|closed/);
	assert.throws(() => first.files(), /expired|closed/);
	assert.throws(() => views.keyed!("v @0"), /expired|closed/);
	const writer = () => new SqliteWriterHost(storage, namespace, projection, { indexProjectionAtoms: true });
	const run = (operation: "record" | "publish", body: unknown, failReceipt = false) =>
		writer().runCalls({
			expected: writer().source(),
			validateAuthority: () => {},
			checkerReady: false,
			operation: (calls) => answer(calls, operation, "alice", body),
			commitReceipt: (result, source) => {
				state.write("receipts", operation, { result, source });
				if (failReceipt) throw Error("receipt failure");
			},
		});
	const rows = () => ({
		log: storage.db.prepare("SELECT * FROM log ORDER BY seq, part").all(),
		state: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace, collection, key, part").all(),
	});
	const before = rows();
	assert.throws(() => run("record", { files: { "b.txt": "failed\n" } }, true), /receipt failure/);
	assert.deepEqual(rows(), before);
	assert.equal(run("record", { files: { "b.txt": "finished\n" } }).status, 200);
	const beforePublish = rows();
	assert.throws(() => run("publish", { message: "Disk first" }, true), /receipt failure/);
	assert.deepEqual(rows(), beforePublish);
	const published = run("publish", { message: "Disk first" });
	assert.equal(published.status, 200);
	assert.equal((published.body as { ok: boolean }).ok, true);
	reopen();
	state = new SqliteWriterState(storage, namespace);
	const beforeRead = rows();
	assert.equal(
		writer().readCalls({
			expected: writer().source(),
			validateAuthority: () => {},
			operation: (calls) => calls.shared().files["b.txt"],
		}),
		"finished\n",
	);
	assert.deepEqual(rows(), beforeRead);
	assert.throws(
		() =>
			writer().runCalls({
				expected,
				validateAuthority: () => {},
				checkerReady: false,
				operation: () => undefined,
				commitReceipt: () => {},
			}),
		/stale/,
	);
	const committed = rows();
	assert.throws(
		() =>
			writer().runCalls({
				expected: writer().source(),
				validateAuthority: () => {
					throw Error("revoked authority");
				},
				checkerReady: false,
				operation: () => undefined,
				commitReceipt: () => {},
			}),
		/revoked authority/,
	);
	assert.deepEqual(rows(), committed);
});
