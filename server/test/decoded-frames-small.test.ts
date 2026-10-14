import assert from "node:assert/strict";
import { test } from "node:test";
import { withDecodedFrames } from "../src/decoded-frames.ts";
import { logParts, SqliteLog } from "../src/engine-project.ts";
import { SqliteWriterState, writerFrameDigest } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("decoded frame pages retain views through consumption and remove scratch on all exits", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const log = new SqliteLog(storage);
	const json = JSON.stringify({ type: "join", agent: "alice", version: 0 });
	for (const [part, text] of logParts(json).entries())
		storage.sql.exec("INSERT INTO log(seq,part,text) VALUES(?,?,?)", 0, part, text);
	SqliteWriterState.initialize(storage);
	const before = storage.db.prepare("SELECT * FROM writer_state").all();
	const input = { from: 0, to: 1, maxEntries: 1, maxBytes: 1000, digest: "" };
	const result = withDecodedFrames(storage, "decoded-page", log, input, (frames) => {
		const frame = [...frames][0]!;
		assert.ok("entry" in frame);
		assert.equal(frame.entry.type, "join");
		assert.equal(
			storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get("decoded-page")!.n,
			0,
		);
		return frame.entry.type;
	});
	assert.equal(result.result, "join");
	assert.equal(result.digest, writerFrameDigest("", 0, json));
	assert.deepEqual(storage.db.prepare("SELECT * FROM writer_state").all(), before);
	assert.throws(
		() =>
			withDecodedFrames(storage, "decoded-page", log, input, (frames) => {
				[...frames];
				throw Error("consumer failure");
			}),
		/consumer failure/,
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM writer_state").all(), before);
});

test("frames above the small bound still use temporary disk storage", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const log = new SqliteLog(storage);
	const agent = "a".repeat(5000);
	const json = JSON.stringify({ type: "join", agent, version: 0 });
	for (const [part, text] of logParts(json).entries())
		storage.sql.exec("INSERT INTO log(seq,part,text) VALUES(?,?,?)", 0, part, text);
	const result = withDecodedFrames(
		storage,
		"large-decoded-page",
		log,
		{ from: 0, to: 1, maxEntries: 1, maxBytes: 10000, digest: "" },
		(frames) => {
			const frame = [...frames][0]!;
			assert.ok("entry" in frame);
			assert.ok(
				Number(
					storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get("large-decoded-page")!.n,
				) > 0,
			);
			assert.equal((frame.entry as { agent: string }).agent, agent);
			return frame.entry.type;
		},
	);
	assert.equal(result.result, "join");
	assert.equal(
		storage.db.prepare("SELECT COUNT(*) AS n FROM writer_state WHERE namespace = ?").get("large-decoded-page")!.n,
		0,
	);
});
