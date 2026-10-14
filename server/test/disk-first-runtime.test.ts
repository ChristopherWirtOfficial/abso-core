import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { where } from "../../worker/project/where.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { type EngineProject, SqliteLog } from "../src/engine-project.ts";
import { SqliteProjectionStore } from "../src/projection-store.ts";
import { SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("runtime defers a large later frame and adopts it on its own page", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const project = new Project(memory);
	project.init({ "a.txt": "small\n" }, 0);
	project.record("alice", { "a.txt": `${"x".repeat(1_100_000)}\n` }, 1);
	project.publish("alice", "Large entry", 2);
	const log = new SqliteLog(storage);
	log.append(memory.entries);
	const large = memory.entries.findIndex((entry) => Buffer.byteLength(JSON.stringify(entry)) > 1_048_576);
	assert.ok(large > 0);
	const before = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const runtime = () => new DiskFirstRuntime(storage, "large-later", "large-later");
	const first = runtime().preparePage(() => {});
	assert.equal(first.phase, "writer");
	assert.equal(first.next, large);
	let pages = 0;
	while (!runtime().preparePage(() => {}).ready) assert.ok(++pages < 100);
	assert.equal(
		runtime().read(
			(calls) => calls.statusAt(log.seq()).version,
			() => {},
		),
		1,
	);
	assert.equal(
		runtime().read(
			(calls) => calls.shared().files["a.txt"]?.length,
			() => {},
		),
		1_100_001,
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), before);
});

test("historical runtime preserves named draft bases and intermediate states after landing", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const project = new Project(memory);
	project.init({ "a.txt": "one\ntwo\n", "b.txt": "other\n" }, 0);
	project.switchTo("alice", "rewrite", 1);
	project.record("alice", { "a.txt": "ONE\ntwo\n" }, 2);
	project.publish("alice", "First draft version", 3);
	project.switchTo("bob", "rewrite", 4);
	project.record("bob", { "b.txt": "OTHER\n" }, 5);
	project.publish("bob", "Second draft version", 6);
	assert.equal(project.land("bob", "Land rewrite", 7).ok, true);
	const expected = memory.entries.map((_, i) => {
		const prefix = Project.load(memory.entries.slice(0, i + 1), new MemoryStore());
		return { status: prefix.status(), where: where(prefix) };
	});
	new SqliteLog(storage).append(memory.entries);
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const runtime = () => new DiskFirstRuntime(storage, "named-history", "named-history");
	while (!runtime().preparePage(() => {}).ready) {}
	for (let at = 1; at <= expected.length; at++) {
		assert.deepEqual(
			runtime().read(
				(calls) => calls.statusAt(at),
				() => {},
			),
			{ at, ...expected[at - 1]!.status },
			`status at ${at}`,
		);
		assert.deepEqual(
			runtime().read(
				(calls) => calls.whereAt(at),
				() => {},
			),
			{ at, ...expected[at - 1]!.where },
			`where at ${at}`,
		);
	}
});

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
	const initialLength = new SqliteLog(storage).seq();
	const initialStatus = runtime().read((calls) => calls.statusAt(initialLength), validate);
	const initialWhere = runtime().read((calls) => calls.whereAt(initialLength), validate);
	// Reproduce the published runtime's ready state before historical indexing existed.
	new SqliteWriterState(storage, "disk-v1").remove("runtime", "history-ready");
	storage.db.exec(
		"DELETE FROM writer_state WHERE namespace LIKE 'disk-v1:history%'; DROP TABLE writer_history_keys; DROP TABLE writer_history_heads;",
	);
	assert.throws(() => runtime().read((calls) => calls.status(), validate), /not complete/);
	assert.throws(() => runtime().write(() => undefined, validate), /not complete/);
	while (!runtime().preparePage(validate).ready) {}
	assert.deepEqual(
		runtime().read((calls) => calls.statusAt(initialLength), validate),
		initialStatus,
	);
	const req = { id: "record-1", identity: { agent: "alice", operation: "record", files: { "a.txt": "changed\n" } } };
	const operation = (calls: Parameters<Parameters<DiskFirstRuntime["write"]>[0]>[0]) =>
		answer(calls, "record", "alice", { files: req.identity.files });
	const first = runtime().write(operation, validate, req);
	assert.equal(first.status, 200);
	const length = new SqliteLog(storage).seq();
	const draftStatus = runtime().read((calls) => calls.statusAt(length), validate);
	const draftWhere = runtime().read((calls) => calls.whereAt(length), validate);
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
	assert.deepEqual(
		runtime().read((calls) => calls.statusAt(initialLength), validate),
		initialStatus,
	);
	assert.deepEqual(
		runtime().read((calls) => calls.whereAt(initialLength), validate),
		initialWhere,
	);
	const end = new SqliteLog(storage).seq();
	assert.deepEqual(
		runtime().read((calls) => calls.statusAt(length), validate),
		draftStatus,
	);
	assert.deepEqual(
		runtime().read((calls) => calls.whereAt(length), validate),
		draftWhere,
	);
	assert.equal(
		runtime().read((calls) => calls.statusAt(end).version, validate),
		1,
	);
	assert.equal(
		runtime().read((calls) => calls.whereAt(end).version, validate),
		1,
	);
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
	const originalWrite = SqliteWriterState.prototype.write;
	const failure = t.mock.method(
		SqliteWriterState.prototype,
		"write",
		function (this: SqliteWriterState, collection: string, key: string, value: unknown) {
			if (collection === "runtime:receipts") throw Error("receipt persistence failed");
			return originalWrite.call(this, collection, key, value);
		},
	);
	assert.throws(
		() =>
			runtime.write(
				(calls) => answer(calls, "record", "alice", { files: { "a.txt": "two\n" } }),
				() => {},
				{ id: "receipt-failed", identity: "record" },
			),
		/receipt persistence failed/,
	);
	assert.deepEqual(rows(), adopted, "receipt failure must roll back canonical state, history and its cursor");
	failure.mock.restore();
});

test("runtime recovers after a writer without historical support commits", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const namespace = "old-writer";
	const runtime = () => new DiskFirstRuntime(storage, "recovery", namespace);
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const historical = runtime().read(
		(calls) => calls.statusAt(1),
		() => {},
	);
	const projection = new SqliteProjectionStore(
		{
			database: "recovery",
			namespace: `${namespace}:views`,
			registry: `${namespace}:roots`,
			defaultFile: "__abso_projection_default__",
		},
		1,
		{ indexedAtoms: true },
	);
	const oldWriter = () => new SqliteWriterHost(storage, namespace, projection, { indexProjectionAtoms: true });
	for (const [op, body] of [
		["record", { files: { "a.txt": "two\n" } }],
		["publish", { message: "Old writer" }],
	] as const) {
		assert.equal(
			oldWriter().runCalls({
				expected: oldWriter().source(),
				validateAuthority: () => {},
				checkerReady: false,
				commitReceipt: () => {},
				operation: (calls) => answer(calls, op, "alice", body),
			}).status,
			200,
		);
	}
	t.mock.method(Project, "load", () => {
		throw Error("full-history load forbidden");
	});
	let ready = false;
	for (let page = 0; page < 100 && !ready; page++) ready = runtime().preparePage(() => {}).ready;
	assert.equal(ready, true);
	assert.deepEqual(
		runtime().read(
			(calls) => calls.statusAt(1),
			() => {},
		),
		historical,
	);
	assert.equal(
		runtime().read(
			(calls) => calls.shared().files["a.txt"],
			() => {},
		),
		"two\n",
	);
	assert.equal(
		runtime().write(
			(calls) => answer(calls, "record", "alice", { files: { "a.txt": "three\n" } }),
			() => {},
		).status,
		200,
	);
});

test("a large retry response must not roll back an otherwise successful write", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "large-receipt", "large-receipt");
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const large = "x".repeat(8_100_000);
	const request = { id: "large-response", identity: { agent: "alice", operation: "large-fixture" } };
	const result = runtime().write(
		(calls) => {
			const recorded = answer(calls, "record", "alice", { files: { "a.txt": "two\n" } });
			assert.equal(recorded.status, 200);
			return { status: 200, body: large };
		},
		() => {},
		request,
	);
	assert.equal(result.body.length, large.length);
	const before = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	const replay = runtime().write(
		() => {
			throw Error("receipt replay must not execute twice");
		},
		() => {},
		request,
	) as typeof result;
	assert.deepEqual(replay, result);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), before);
});

test("chunked receipts roll back failures and reject damaged replay", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "receipt-failure", "receipt-failure");
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const rows = () => ({
		log: storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(),
		state: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		history: storage.db.prepare("SELECT * FROM writer_history_keys ORDER BY namespace,collection,key,revision").all(),
		heads: storage.db.prepare("SELECT * FROM writer_history_heads ORDER BY namespace").all(),
	});
	const before = rows();
	const original = SqliteWriterState.prototype.write;
	const failure = t.mock.method(
		SqliteWriterState.prototype,
		"write",
		function (this: SqliteWriterState, collection: string, key: string, value: unknown) {
			original.call(this, collection, key, value);
			if (collection === "runtime:receipt:chunk-failure" && key === "1") throw Error("injected receipt chunk failure");
		},
	);
	const request = { id: "chunk-failure", identity: { operation: "fixture" } };
	const operation = (calls: EngineProject) => {
		assert.equal(answer(calls, "record", "alice", { files: { "a.txt": "two\n" } }).status, 200);
		return { body: "x".repeat(140000) };
	};
	assert.throws(() => runtime().write(operation, () => {}, request), /injected receipt chunk failure/);
	assert.deepEqual(rows(), before);
	failure.mock.restore();
	const result = runtime().write(operation, () => {}, request);
	const committed = rows();
	assert.deepEqual(
		runtime().write(
			() => {
				throw Error("must not execute");
			},
			() => {},
			request,
		),
		result,
	);
	assert.deepEqual(rows(), committed);
	const state = new SqliteWriterState(storage, "receipt-failure");
	const chunk = state.read("runtime:receipt:chunk-failure", "1") as string;
	state.write("runtime:receipt:chunk-failure", "1", "y" + chunk.slice(1));
	assert.throws(
		() =>
			runtime().write(
				() => {
					throw Error("must not execute");
				},
				() => {},
				request,
			),
		/digest mismatch/,
	);
	state.remove("runtime:receipt:chunk-failure", "1");
	assert.throws(
		() =>
			runtime().write(
				() => {
					throw Error("must not execute");
				},
				() => {},
				request,
			),
		/incomplete receipt/,
	);
	assert.deepEqual(rows().log, committed.log);
});

test("runtime format upgrade is authorized, atomic, and rejects unknown formats", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "format-test", "format-test");
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const state = new SqliteWriterState(storage, "format-test");
	assert.equal(state.read("runtime", "format"), 5);
	state.write("runtime", "format", 3);
	const before = storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all();
	let validations = 0;
	assert.throws(
		() =>
			runtime().preparePage(() => {
				if (++validations === 2) throw Error("revoked during upgrade");
			}),
		/revoked/,
	);
	assert.deepEqual(
		storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		before,
	);
	assert.equal(runtime().preparePage(() => {}).ready, true);
	assert.equal(state.read("runtime", "format"), 5);
	state.write("runtime", "format", 999);
	assert.throws(() => runtime().preparePage(() => {}), /unsupported disk-first runtime format/);
	assert.equal(state.read("runtime", "format"), 999);
});
