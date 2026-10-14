import assert from "node:assert/strict";
import { test } from "node:test";
import { withDecodedFrames } from "../src/decoded-frames.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

for (const padding of [0, 5000]) {
	test(`canonical frames reject numeric overflow with ${padding} padding bytes and clean scratch`, (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const log = new SqliteLog(storage);
		const json = `{"type":"join","agent":"${"a".repeat(padding)}","version":1e400}`;
		storage.sql.exec("INSERT INTO log(seq,part,text) VALUES(?,?,?)", 0, 0, json);
		SqliteWriterState.initialize(storage);
		const rows = () => storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all();
		const before = rows();
		assert.throws(
			() =>
				withDecodedFrames(
					storage,
					"number-frame",
					log,
					{ from: 0, to: 1, maxEntries: 1, maxBytes: 10000, digest: "" },
					(frames) => [...frames],
				),
			/non-finite JSON number/,
		);
		assert.deepEqual(rows(), before);
		assert.equal(storage.db.prepare("SELECT text FROM log WHERE seq=0 AND part=0").get()!.text, json);
	});
}
