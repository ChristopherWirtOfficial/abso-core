import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../../worker/project/project.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteHistoryHost } from "../src/history-host.ts";
import { advanceWriterRoot, SqliteWriterHost, SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("history preparation and advancement never reconstruct a canonical frame string", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const memory = new MemoryStore();
	const oracle = new Project(memory);
	oracle.init({ "a.txt": "before\n" }, 0);
	const log = new SqliteLog(storage);
	log.append(memory.entries);
	SqliteWriterState.initialize(storage);
	const writer = new SqliteWriterHost(storage, "writer");
	writer.adoptPage(0, { maxEntries: 32, maxBytes: 100000 }, () => {});
	const root = writer.root();
	t.mock.method(log, "boundedFrame", () => {
		throw Error("whole canonical frame forbidden");
	});
	t.mock.method(Project, "load", () => {
		throw Error("whole history forbidden");
	});
	const history = new SqliteHistoryHost(storage, "streamed-history");
	while (
		!history.prepare(
			log,
			root,
			() => root,
			() => {},
		).ready
	) {}
	oracle.record("alice", { "a.txt": "after\n" }, 1);
	oracle.publish("alice", "change", 2);
	log.append(memory.entries.slice(root.logLength));
	const committed = advanceWriterRoot(log, root, writer.source());
	history.advance(
		log,
		root,
		committed,
		() => committed,
		() => {},
	);
	assert.deepEqual(
		history.read(
			committed,
			() => committed,
			() => {},
			committed.logLength,
			(p) => p.files(),
		),
		oracle.files(),
	);
	assert.equal(
		history.read(
			committed,
			() => committed,
			() => {},
			1,
			(p) => p.files(),
		)["a.txt"],
		"before\n",
	);
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace='streamed-history:decoded'").get()!.n,
		0,
	);
});
