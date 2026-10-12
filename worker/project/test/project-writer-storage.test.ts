import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";
import { WriterAgents } from "../writer-agents.ts";

function setup() {
	const storage = new SqlState();
	const entries = storedArray<Entry>(storage, "canonical-log");
	let failAppend = false;
	const store: ProjectStore = {
		append(batch) {
			for (const entry of batch) {
				entries.push(entry);
				if (failAppend) throw new Error("injected canonical append failure");
			}
		},
	};
	return {
		storage,
		entries,
		store,
		fail: () => {
			failAppend = true;
		},
		recover: () => {
			failAppend = false;
		},
	};
}

test("actor fence reads neither enumerate other agents nor project their files", (t) => {
	const { storage, entries, store } = setup();
	let project = new Project(store, { writerStorage: storage });
	storage.transaction(() => project.init({ "a.txt": "one\n" }, 0));
	storage.transaction(() => project.record("writer", { "a.txt": "ONE\n" }, 1));
	storage.transaction(() => project.record("other", { "a.txt": "OTHER\n" }, 2));
	const status = project.status().agents.find((agent) => agent.agent === "writer")!;
	project = Project.openWriter(store, storage, entries.length);
	t.mock.method(WriterAgents.prototype, "entries", () => {
		throw new Error("all-agent scan forbidden");
	});
	t.mock.method(Project.prototype, "status", () => {
		throw new Error("full status projection forbidden");
	});
	assert.deepEqual(project.actorHead("writer"), { base: status.base, draftChanges: status.draftChanges, draft: null });
	assert.equal(project.actorHead("absent"), undefined);
	storage.db.close();
});

test("actual Project record and publish use persistent graph, membership and positional indexes", (t) => {
	t.mock.method(Date, "now", () => 100);
	const { storage, entries, store } = setup();
	let project = new Project(store, { writerStorage: storage });
	t.mock.method(Project, "load", () => {
		throw new Error("checkpoint path must not replay the log");
	});
	const oracleLog = new MemoryStore();
	const oracle = new Project(oracleLog);
	const run = <T>(operation: (p: Project) => T) => {
		const expected = operation(oracle);
		const actual = storage.transaction(() => operation(project));
		assert.deepEqual(actual, expected);
		assert.deepEqual(project.files(), oracle.files());
		assert.deepEqual(project.changes(0), oracle.changes(0));
		assert.deepEqual(project.notes({ file: "a.txt" }), oracle.notes({ file: "a.txt" }));
		assert.deepEqual([...entries], oracleLog.entries);
		project = Project.openWriter(store, storage, entries.length);
		assert.deepEqual(project.files(), oracle.files(), "reopened checkpoint preserves published files");
		assert.deepEqual(
			project.status(),
			oracle.status(),
			"reopened checkpoint preserves agents, drafts and history state",
		);
	};
	run((p) => p.init({ "a.txt": "one\ntwo\n", "b.txt": "alpha\n" }, 0));
	run((p) => p.record("writer", { "a.txt": "ONE\ntwo\n" }, 1));
	run((p) => p.publish("writer", "Edit", 2));
	run((p) => p.note("writer", { file: "a.txt", from: 1, to: 1, text: "Review this", kind: "objection" }, 2));
	run((p) => p.record("writer", { "a.txt": "ONE\ntwo\n" }, 3));
	run((p) => p.record("left", { "a.txt": "LEFT\ntwo\n" }, 4));
	run((p) => p.record("right", { "a.txt": "RIGHT\ntwo\n" }, 5));
	run((p) => p.publish("left", "Left", 6));
	run((p) => p.publish("right", "Right", 7));
	run((p) => p.closeNote("writer", 1, "resolved", 8));
	run((p) => p.switchTo("writer", "branch", 9));
	run((p) => p.record("writer", { "b.txt": "BETA\n" }, 10));
	run((p) => p.publish("writer", "Branch edit", 11));
	run((p) => p.land("writer", "Land branch", 12));
	run((p) => p.announce("writer", "Please review", ["left"], 13));
	run((p) => p.news("left"));
	assert.deepEqual(project.position({ version: 1 }), oracle.position({ version: 1 }));
	assert.deepEqual(project.position({ time: 3 }), oracle.position({ time: 3 }));
	assert.throws(() => new Project(store, { writerStorage: storage }), /checkpoint reopen is required/);
	assert.throws(() => Project.openWriter(store, storage, entries.length + 1), /does not match/);
	storage.db.close();
});

test("queued publish survives checkpoint reopen and lands with the same candidate", () => {
	const { storage, entries, store } = setup();
	let project = new Project(store, { writerStorage: storage });
	project.checkerReady = true;
	storage.transaction(() => project.init({ "avcs.json": '{"queue":true}\n', "a.txt": "one\n" }, 0));
	storage.transaction(() => project.record("writer", { "a.txt": "ONE\n" }, 1));
	const queued = storage.transaction(() => project.publish("writer", "Queued edit", 2));
	assert.ok(queued.ok && "queued" in queued);
	const before = project.queueCandidate(1);
	project = Project.openWriter(store, storage, entries.length);
	project.checkerReady = true;
	assert.deepEqual(project.queueCandidate(1), before);
	storage.transaction(() => project.queueLand(1, 3));
	const reopened = Project.openWriter(store, storage, entries.length);
	assert.equal(reopened.files()["a.txt"], "ONE\n");
	assert.deepEqual(reopened.queue().items, []);
	storage.db.close();
});

test("failure after log append rolls back the log and persistent Project counters", (t) => {
	const { storage, entries, store } = setup();
	const project = new Project(store, { writerStorage: storage });
	storage.transaction(() => project.init({ "a.txt": "one\n" }, 0));
	const snapshot = () => storage.db.prepare("SELECT * FROM state ORDER BY collection, key").all();
	const before = snapshot();
	const length = entries.length;
	const write = storage.write.bind(storage);
	t.mock.method(storage, "write", (collection: string, key: string, value: unknown) => {
		if (collection === "project:meta" && key === "stored") {
			assert.ok(entries.length > length, "the failure occurs after the canonical append");
			throw new Error("injected checkpoint counter failure");
		}
		write(collection, key, value);
	});
	assert.throws(
		() => storage.transaction(() => project.record("writer", { "a.txt": "ONE\n" }, 1)),
		/checkpoint counter failure/,
	);
	assert.deepEqual(snapshot(), before);
	storage.db.close();
});

test("outer transaction rolls back canonical append and every Project writer index", () => {
	const { storage, store, entries, fail, recover } = setup();
	const project = new Project(store, { writerStorage: storage });
	storage.transaction(() => project.init({ "a.txt": "one\n" }, 0));
	const snapshot = () => storage.db.prepare("SELECT * FROM state ORDER BY collection, key").all();
	const before = snapshot();
	fail();
	assert.throws(
		() => storage.transaction(() => project.record("writer", { "a.txt": "ONE\n" }, 1)),
		/canonical append failure/,
	);
	assert.deepEqual(snapshot(), before, "log, graph, membership and positional state roll back together");
	// Discard the failed in-memory instance and retry from the committed root.
	recover();
	const reopened = Project.openWriter(store, storage, entries.length);
	storage.transaction(() => reopened.record("writer", { "a.txt": "ONE\n" }, 1));
	storage.transaction(() => reopened.publish("writer", "Retry", 2));
	assert.deepEqual(Project.openWriter(store, storage, entries.length).files(), { "a.txt": "ONE\n" });
	storage.db.close();
});
