import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { logParts, SqliteLog } from "../src/engine-project.ts";
import { writerFrameChunksDigest, writerFrameDigest } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("canonical chunks stream oversized frames and reject missing parts", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const log = new SqliteLog(storage);
	const json = JSON.stringify({ value: "x".repeat(8_100_000) });
	for (const [part, text] of logParts(json).entries())
		storage.sql.exec("INSERT INTO log (seq,part,text) VALUES (?, ?, ?)", 0, part, text);
	assert.equal(writerFrameChunksDigest("", 0, log.frameChunks(0)), writerFrameDigest("", 0, json));
	storage.sql.exec("DELETE FROM log WHERE seq = 0 AND part = 1");
	assert.throws(() => {
		for (const _ of log.frameChunks(0)) {
		}
	}, /incomplete/);
	assert.throws(() => log.frameChunks(1).next(), /missing/);
});
test("chunked writer digests preserve Unicode across every split", () => {
	const text = '{"value":"a\u{1f600}b\u{1d11e}c"}'.replace(/\\u\{([0-9a-f]+)\}/g, (_, hex) =>
		String.fromCodePoint(Number.parseInt(hex, 16)),
	);
	const reference = createHash("sha256")
		.update("abso-writer-log-v1\n")
		.update(JSON.stringify(["prior", 7]))
		.update("\n")
		.update(text, "utf8")
		.digest("hex");
	for (let at = 0; at <= text.length; at++)
		assert.equal(writerFrameChunksDigest("prior", 7, [text.slice(0, at), "", text.slice(at)]), reference);
});
