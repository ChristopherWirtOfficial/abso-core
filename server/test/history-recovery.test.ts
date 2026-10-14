import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteHistoryHost } from "../src/history-host.ts";
import { advanceWriterRoot, SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("historical preparation recovers after a writer without history appends", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const project = new Project(memory);
	project.init({ "a.txt": "one\n" }, 0);
	for (let i = 1; i <= 20; i++) {
		project.record("alice", { "a.txt": `before ${i}\n` }, i * 2);
		project.publish("alice", `Before ${i}`, i * 2 + 1);
	}
	const log = new SqliteLog(storage);
	log.append(memory.entries);
	SqliteWriterState.initialize(storage);
	const writer = new SqliteWriterHost(storage, "writer");
	let from = 0;
	for (;;) {
		const page = writer.adoptPage(from, { maxEntries: 32, maxBytes: 1048576 }, () => {});
		from = page.next;
		if (page.ready) break;
	}
	const previous = writer.root();
	const history = () => new SqliteHistoryHost(storage, "history");
	while (
		!history().prepare(
			log,
			previous,
			() => previous,
			() => {},
		).ready
	) {}
	const oldStatus = project.status();
	project.record("alice", { "a.txt": "two\n" }, 1);
	project.publish("alice", "Second", 2);
	log.append(memory.entries.slice(previous.logLength));
	const current = advanceWriterRoot(log, previous, writer.source());
	// The previous runtime commits canonical history but does not advance historical indexes.
	assert.equal(
		history().prepare(
			log,
			current,
			() => current,
			() => {},
		).ready,
		false,
	);
	let ready = false;
	for (let page = 0; page < 20 && !ready; page++) {
		ready = history().prepare(
			log,
			current,
			() => current,
			() => {},
		).ready;
	}
	assert.equal(ready, true);
	assert.deepEqual(
		history().read(
			current,
			() => current,
			() => {},
			previous.logLength,
			(p) => p.status(),
		),
		oldStatus,
	);
	assert.deepEqual(
		history().read(
			current,
			() => current,
			() => {},
			current.logLength,
			(p) => p.status(),
		),
		project.status(),
	);
});

for (const shortened of [false, true]) {
	test(`historical recovery rebuilds ${shortened ? "shortened" : "replaced"} canonical history`, (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const memory = new MemoryStore();
		const project = new Project(memory);
		project.init({ "old.txt": "old\n" }, 0);
		project.record("alice", { "old.txt": "changed\n" }, 1);
		project.publish("alice", "Old", 2);
		const log = new SqliteLog(storage);
		log.append(memory.entries);
		SqliteWriterState.initialize(storage);
		const empty = { format: 1 as const, generation: 0, logLength: 0, sharedVersion: 0, digest: "" };
		const oldRoot = advanceWriterRoot(log, empty, {
			generation: log.generation(),
			logLength: log.seq(),
			sharedVersion: project.version,
		});
		const history = () => new SqliteHistoryHost(storage, "history");
		while (
			!history().prepare(
				log,
				oldRoot,
				() => oldRoot,
				() => {},
			).ready
		) {}
		const replacement = new MemoryStore();
		const current = new Project(replacement);
		current.init({ "new.txt": "new\n" }, 0);
		if (!shortened) {
			current.record("bob", { "new.txt": "different\n" }, 1);
			current.publish("bob", "New", 2);
		}
		log.clear();
		log.append(replacement.entries);
		const root = advanceWriterRoot(log, empty, {
			generation: log.generation(),
			logLength: log.seq(),
			sharedVersion: current.version,
		});
		const canonical = JSON.stringify(log.since(0, 100));
		assert.equal(
			history().prepare(
				log,
				root,
				() => root,
				() => {},
			).ready,
			false,
		);
		assert.throws(
			() =>
				history().read(
					root,
					() => root,
					() => {},
					1,
					(p) => p.status(),
				),
			/not ready/,
		);
		const rows = () => ({
			state: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
			keys: storage.db.prepare("SELECT * FROM writer_history_keys ORDER BY namespace,collection,key,revision").all(),
			heads: storage.db.prepare("SELECT * FROM writer_history_heads ORDER BY namespace").all(),
		});
		const beforeCleanup = rows();
		let validations = 0;
		assert.throws(
			() =>
				history().prepare(
					log,
					root,
					() => root,
					() => {
						if (++validations === 2) throw Error("authority revoked during cleanup");
					},
				),
			/authority revoked/,
		);
		assert.deepEqual(rows(), beforeCleanup);
		let ready = false;
		for (let page = 0; page < 100 && !ready; page++)
			ready = history().prepare(
				log,
				root,
				() => root,
				() => {},
			).ready;
		assert.equal(ready, true);
		assert.deepEqual(
			history().read(
				root,
				() => root,
				() => {},
				root.logLength,
				(p) => p.status(),
			),
			current.status(),
		);
		assert.equal(JSON.stringify(log.since(0, 100)), canonical);
	});
}
