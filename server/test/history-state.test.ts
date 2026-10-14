import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { where } from "../../worker/project/where.ts";
import { EngineProject } from "../src/engine-project.ts";
import { SqliteHistoryState } from "../src/history-state.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("bounded adoption checkpoints reopen every historical Project prefix without replay", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	SqliteHistoryState.initialize(storage);
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "one\ntwo\n" }, 0);
	project.record("alice", { "a.txt": "ONE\ntwo\n" }, 1);
	project.publish("alice", "First", 2);
	project.move("alice", "a.txt", "b.txt", 3);
	project.publish("alice", "Move", 4);
	const expected = log.entries.map((_, i) => {
		const prefix = Project.load(log.entries.slice(0, i + 1), new MemoryStore());
		return { status: prefix.status(), where: where(prefix) };
	});
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const source = { generation: 1, logLength: log.entries.length, sharedVersion: project.version };
	let from = 0;
	while (from < log.entries.length) {
		const state = new SqliteHistoryState(storage, "project-history", from);
		const frames = log.entries
			.slice(from, from + 2)
			.map((entry, i) => ({ seq: from + i, json: JSON.stringify(entry) }));
		const page = Project.adoptWriterPage(state, {
			source,
			from,
			frames,
			maxEntries: 2,
			maxBytes: 16384,
			currentSource: () => source,
			beginRevision: (revision) => state.beginRevision(revision),
		});
		from = page.next;
	}
	const state = new SqliteHistoryState(storage, "project-history", from);
	state.seal();
	let active = true;
	const calls = new EngineProject(project, undefined, undefined, (at, operation) => {
		const validate = () => {
			if (!active) throw Error("historical scope expired");
		};
		validate();
		return operation(
			at === 0
				? new Project(new MemoryStore())
				: Project.openHistorical(state.at(at, validate), at, new SqliteWriterState(storage, "history-scratch")),
		);
	});
	assert.deepEqual(calls.statusAt(0), { at: 0, version: -1, agents: [] });
	assert.deepEqual(calls.whereAt(0), { at: 0, version: -1, files: {} });
	for (let at = 1; at <= from; at++) {
		const historical = Project.openHistorical(state.at(at), at, new SqliteWriterState(storage, "history-scratch"));
		assert.deepEqual(historical.status(), expected[at - 1]!.status, `status at ${at}`);
		assert.deepEqual(where(historical), expected[at - 1]!.where, `where at ${at}`);
		assert.deepEqual(calls.statusAt(at), { at, ...expected[at - 1]!.status });
		assert.deepEqual(calls.whereAt(at), { at, ...expected[at - 1]!.where });
	}
	assert.deepEqual(calls.statusAt(from + 10), { at: from, ...expected[from - 1]!.status });
	active = false;
	assert.throws(() => calls.statusAt(1), /scope expired/);
	assert.throws(() => calls.whereAt(1), /scope expired/);
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = 'history-scratch'").get()!.n,
		0,
	);
});

test("historical state preserves old values, deletions and undefined across reopen", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	SqliteHistoryState.initialize(storage);
	let state = new SqliteHistoryState(storage, "history");
	state.beginRevision(1);
	state.write("values", "", "empty key");
	for (let i = 0; i < 150; i++) state.write("values", `key-${i.toString().padStart(3, "0")}`, { value: i });
	state.write("values", "undefined", undefined);
	state.beginRevision(2);
	state.write("values", "key-000", { value: "changed" });
	state.remove("values", "key-001");
	state.remove("values", "undefined");
	state.seal();
	state = new SqliteHistoryState(storage, "history", 2);
	assert.deepEqual(state.at(1).read("values", "key-000"), { value: 0 });
	assert.deepEqual(state.at(2).read("values", "key-000"), { value: "changed" });
	const old = new Map(state.at(1).entries("values"));
	const current = new Map(state.at(2).entries("values"));
	assert.equal(old.size, 152);
	assert.equal(current.size, 150);
	assert.equal(old.has("undefined"), true);
	assert.equal(current.has("undefined"), false);
	assert.equal(current.has("key-001"), false);
	assert.equal(current.get(""), "empty key");
	assert.throws(() => state.at(3), /outside authority/);
	assert.throws(() => state.at(1).write("values", "bad", 1), /read-only/);
	assert.throws(() => state.write("values", "bad", 1), /sealed/);
	const reopened = new SqliteHistoryState(storage, "history", 2);
	assert.throws(() => reopened.write("values", "key-000", "overwrite"), /sealed/);
	reopened.beginRevision(3);
	reopened.write("values", "key-000", "new revision");
	reopened.seal();
	assert.deepEqual(reopened.at(2).read("values", "key-000"), { value: "changed" });
});

test("new canonical tails extend historical snapshots atomically without replaying old entries", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	SqliteHistoryState.initialize(storage);
	const log = new MemoryStore();
	const live = new Project(log);
	live.init({ "a.txt": "one\ntwo\n" }, 0);
	const initialLength = log.entries.length;
	const initial = live.status();
	const state = new SqliteHistoryState(storage, "tail");
	const source = { generation: 1, logLength: initialLength, sharedVersion: live.version };
	Project.adoptWriterPage(state, {
		source,
		from: 0,
		maxEntries: 256,
		maxBytes: 16384,
		frames: log.entries.map((entry, seq) => ({ seq, json: JSON.stringify(entry) })),
		currentSource: () => source,
		beginRevision: (revision) => state.beginRevision(revision),
	});
	state.seal();
	live.record("alice", { "a.txt": "ONE\ntwo\n" }, 1);
	live.publish("alice", "First", 2);
	const expected = log.entries.map((_, i) => {
		const p = Project.load(log.entries.slice(0, i + 1), new MemoryStore());
		return { status: p.status(), where: where(p) };
	});
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const rows = () => ({
		values: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		history: storage.db.prepare("SELECT * FROM writer_history_keys ORDER BY namespace,collection,key,revision").all(),
		heads: storage.db.prepare("SELECT * FROM writer_history_heads ORDER BY namespace").all(),
	});
	const before = rows();
	const frames = log.entries
		.slice(initialLength)
		.map((entry, i) => ({ seq: initialLength + i, json: JSON.stringify(entry) }));
	let validations = 0;
	assert.throws(
		() =>
			Project.extendHistoricalPage(state, {
				from: initialLength,
				frames,
				maxEntries: 256,
				maxBytes: 16384,
				beginRevision: (revision) => state.beginRevision(revision),
				validateAuthority: () => {
					if (++validations === 2) throw Error("canonical tail changed");
				},
			}),
		/canonical tail changed/,
	);
	assert.deepEqual(rows(), before);
	let from = initialLength;
	while (from < log.entries.length) {
		const reopened = new SqliteHistoryState(storage, "tail", from);
		const page = Project.extendHistoricalPage(reopened, {
			from,
			frames: frames.filter((frame) => frame.seq >= from).slice(0, 2),
			maxEntries: 2,
			maxBytes: 16384,
			beginRevision: (revision) => reopened.beginRevision(revision),
			validateAuthority: () => {},
		});
		reopened.seal();
		from = page.next;
	}
	const reopened = new SqliteHistoryState(storage, "tail", from);
	const scratch = new SqliteWriterState(storage, "tail-scratch");
	assert.deepEqual(Project.openHistorical(reopened.at(initialLength), initialLength, scratch).status(), initial);
	for (let at = initialLength + 1; at <= from; at++) {
		const historical = Project.openHistorical(reopened.at(at), at, scratch);
		assert.deepEqual(historical.status(), expected[at - 1]!.status);
		assert.deepEqual(where(historical), expected[at - 1]!.where);
	}
});

test("current state and its history roll back together", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	SqliteHistoryState.initialize(storage);
	const state = new SqliteHistoryState(storage, "rollback");
	state.beginRevision(1);
	state.write("values", "a", { before: true });
	state.seal();
	const rows = () => ({
		values: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		history: storage.db.prepare("SELECT * FROM writer_history_keys ORDER BY namespace,collection,key,revision").all(),
		heads: storage.db.prepare("SELECT * FROM writer_history_heads ORDER BY namespace").all(),
	});
	const before = rows();
	assert.throws(
		() =>
			state.transaction(() => {
				state.beginRevision(2);
				state.write("values", "a", { after: true });
				state.remove("values", "a");
				state.seal();
				throw Error("injected failure");
			}),
		/injected failure/,
	);
	assert.deepEqual(rows(), before);
	assert.throws(() => state.at(2), /outside authority/);
	assert.deepEqual(state.read("values", "a"), { before: true });
});

test("historical readers recheck canonical authority after creation and between yielded keys", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	SqliteHistoryState.initialize(storage);
	const state = new SqliteHistoryState(storage, "authority");
	state.beginRevision(1);
	state.write("values", "a", 1);
	state.write("values", "b", 2);
	state.seal();
	let valid = true;
	const guard = () => {
		if (!valid) throw Error("canonical authority expired");
	};
	const historical = state.at(1, guard);
	const iterator = historical.entries("values")[Symbol.iterator]();
	assert.deepEqual(iterator.next().value, ["a", 1]);
	valid = false;
	assert.throws(() => iterator.next(), /authority expired/);
	assert.throws(() => historical.read("values", "a"), /authority expired/);
	assert.throws(() => historical.entries("values")[Symbol.iterator]().next(), /authority expired/);
	let called = false;
	assert.throws(
		() =>
			historical.transaction(() => {
				called = true;
			}),
		/authority expired/,
	);
	assert.equal(called, false);
	assert.throws(() => state.at(1, guard), /authority expired/);
});
