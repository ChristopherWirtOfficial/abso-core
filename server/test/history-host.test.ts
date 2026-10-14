import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteHistoryHost } from "../src/history-host.ts";
import { advanceWriterRoot, SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("historical host binds paged snapshots to the verified canonical root", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const project = new Project(memory);
	project.init({ "a.txt": "one\n" }, 0);
	for (let i = 1; i <= 18; i++) {
		project.record("alice", { "a.txt": `${i}\n` }, i * 2);
		project.publish("alice", `Change ${i}`, i * 2 + 1);
	}
	const expected = memory.entries.map((_, index) =>
		Project.load(memory.entries.slice(0, index + 1), new MemoryStore()).status(),
	);
	const log = new SqliteLog(storage);
	log.append(memory.entries);
	SqliteWriterState.initialize(storage);
	const writer = new SqliteWriterHost(storage, "writer");
	let from = 0;
	for (;;) {
		const page = writer.adoptPage(from, { maxEntries: 32, maxBytes: 1_048_576 }, () => {});
		from = page.next;
		if (page.ready) break;
	}
	const root = writer.root();
	t.mock.method(Project, "load", () => {
		throw Error("full-history replay forbidden");
	});
	const history = () => new SqliteHistoryHost(storage, "history");
	let pages = 0;
	while (
		!history().prepare(
			log,
			root,
			() => writer.root(),
			() => {},
		).ready
	) {
		pages++;
		assert.throws(
			() =>
				history().read(
					root,
					() => writer.root(),
					() => {},
					1,
					(p) => p.status(),
				),
			/not ready/,
		);
	}
	assert.ok(pages > 0);
	let authorized = true;
	assert.throws(
		() =>
			history().read(
				root,
				() => root,
				() => {
					if (!authorized) throw Error("authority expired during read");
				},
				1,
				(p) => {
					const result = p.status();
					authorized = false;
					return result;
				},
			),
		/authority expired during read/,
	);
	let observedRoot = root;
	assert.throws(
		() =>
			history().read(
				root,
				() => observedRoot,
				() => {},
				1,
				(p) => {
					const result = p.status();
					observedRoot = { ...root, generation: root.generation + 1 };
					return result;
				},
			),
		/root changed/,
	);
	for (let at = 1; at <= root.logLength; at++) {
		assert.deepEqual(
			history().read(
				root,
				() => writer.root(),
				() => {},
				at,
				(p) => p.status(),
			),
			expected[at - 1],
		);
	}
	assert.throws(
		() =>
			history().read(
				root,
				() => ({ ...root, generation: root.generation + 1 }),
				() => {},
				1,
				(p) => p.status(),
			),
		/root changed/,
	);
	assert.throws(
		() =>
			history().read(
				root,
				() => root,
				() => {
					throw Error("revoked");
				},
				1,
				(p) => p.status(),
			),
		/revoked/,
	);
	const rows = () => ({
		values: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
		history: storage.db.prepare("SELECT * FROM writer_history_keys ORDER BY namespace,collection,key,revision").all(),
		heads: storage.db.prepare("SELECT * FROM writer_history_heads ORDER BY namespace").all(),
	});
	const before = rows();
	project.record("alice", { "a.txt": "tail\n" }, 100);
	project.publish("alice", "Tail", 101);
	log.append(memory.entries.slice(root.logLength));
	const committed = advanceWriterRoot(log, root, writer.source());
	const wrong = { ...committed, digest: "0".repeat(64) };
	assert.throws(
		() =>
			history().advance(
				log,
				root,
				wrong,
				() => wrong,
				() => {},
			),
		/tail digest mismatch/,
	);
	assert.deepEqual(rows(), before);
	history().advance(
		log,
		root,
		committed,
		() => committed,
		() => {},
	);
	assert.deepEqual(
		history().read(
			committed,
			() => committed,
			() => {},
			committed.logLength,
			(p) => p.status(),
		),
		project.status(),
	);
	assert.deepEqual(
		history().read(
			committed,
			() => committed,
			() => {},
			root.logLength,
			(p) => p.status(),
		),
		expected.at(-1),
	);
});
