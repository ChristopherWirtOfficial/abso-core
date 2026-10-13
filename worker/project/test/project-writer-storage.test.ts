import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	indexAcceptedProjectionAtom,
	ProjectionAtomIndex,
} from "../../../src/engine/experimental/projection-atom-index.ts";
import { Graph } from "../../../src/engine/graph.ts";
import { StableSet, storedArray } from "../../../src/engine/state-source.ts";
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

test("persistent publish keeps membership indexed through union and conflict checks", (t) => {
	const { storage, entries, store } = setup();
	try {
		let project = new Project(store, { writerStorage: storage });
		storage.transaction(() => project.init({ "a.txt": "one\n", "b.txt": "two\n" }, 0));
		storage.transaction(() => project.record("writer", { "a.txt": "ONE\n" }, 1));
		storage.transaction(() => project.record("other", { "b.txt": "TWO\n" }, 2));
		storage.transaction(() => project.publish("other", "Other file", 3));
		project = Project.openWriter(store, storage, entries.length);
		t.mock.method(Graph.prototype, "closureOf", () => {
			throw new Error("materialized membership closure is forbidden");
		});
		const result = storage.transaction(() => project.publish("writer", "Merge without history copies", 4));
		assert.equal(result.ok, true);
		assert.deepEqual(Project.openWriter(store, storage, entries.length).files(), {
			"a.txt": "ONE\n",
			"b.txt": "TWO\n",
		});
	} finally {
		storage.db.close();
	}
});

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

test("empty writer drafts reuse their exact published base projection without conflating newer heads", () => {
	const { storage, entries, store } = setup();
	let project = new Project(store, { writerStorage: storage });
	storage.transaction(() => project.init({ "a.txt": "one\n" }, 0));
	storage.transaction(() => project.record("writer", { "a.txt": "two\n" }, 1));
	storage.transaction(() => project.publish("writer", "Two", 2));
	project = Project.openWriter(store, storage, entries.length);
	const base = project.sharedView();
	assert.ok(base.set instanceof StableSet, "published membership must remain indexed rather than copied into a Set");
	assert.equal(project.draftOf("writer")!.view, base);
	assert.equal(base.text("a.txt"), "two\n");
	storage.transaction(() => project.record("other", { "a.txt": "three\n" }, 3));
	assert.notEqual(project.draftOf("other")!.view, base);
	storage.transaction(() => project.publish("other", "Three", 4));
	assert.equal(project.sharedView().text("a.txt"), "three\n");
	assert.equal(project.draftOf("writer")!.view, base, "an unchanged actor stays at its old base");
	assert.equal(project.draftOf("writer")!.view.text("a.txt"), "two\n");
	assert.notEqual(project.draftOf("writer")!.view, project.sharedView());
	assert.equal(project.draftOf("other")!.view, project.sharedView());
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

test("opted-in descriptor indexing survives writer reopen and rolls back canonical append failure", () => {
	const fixture = setup();
	const { storage, entries, store } = fixture;
	const options = { indexAcceptedAtom: indexAcceptedProjectionAtom };
	try {
		let project = new Project(store, { writerStorage: storage, ...options });
		storage.transaction(() => project.init({ "a.txt": "one\n" }, 0));
		project = Project.openWriter(store, storage, entries.length, options);
		const rows = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		fixture.fail();
		assert.throws(
			() => storage.transaction(() => project.record("writer", { "a.txt": "two\n" }, 1)),
			/canonical append failure/,
		);
		assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), rows);
		fixture.recover();
		project = Project.openWriter(store, storage, entries.length, options);
		storage.transaction(() => project.record("writer", { "a.txt": "two\n" }, 1));
		storage.transaction(() => project.publish("writer", "Indexed", 2));
		const graph = new Graph({ storage });
		for (const atom of graph.atoms()) {
			const digest = createHash("sha256").update(JSON.stringify(atom)).digest("hex");
			assert.equal(new ProjectionAtomIndex(storage).open(atom.id, digest).seq, atom.seq);
		}
		assert.deepEqual(Project.openWriter(store, storage, entries.length, options).files(), { "a.txt": "two\n" });
	} finally {
		storage.db.close();
	}
});
