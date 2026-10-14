import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { SqlState } from "./storage-helper.ts";

test("stored insertion reads reject missing lines and substituted run references", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const lines = Array.from({ length: 257 }, (_, i) => (i === 128 ? "x".repeat(40000) : `line ${i}`));
	const atom = buildBase({ "a.txt": lines.join("\n") }, { author: "fixture", message: "base", time: 0 });
	new Graph({ storage }).add(atom);
	assert.equal(new Graph({ storage }).atom("a0").inserts[0]!.lines[128], lines[128]);
	storage.remove("atom-inserts:0:lines:0", "12");
	assert.throws(() => new Graph({ storage }).atom("a0").inserts[0]!.lines[12], /missing stored list element/);
	const run = storage.read("atom-inserts:0", "0") as Record<string, unknown>;
	storage.write("atom-inserts:0", "0", { ...run, lines: "unrelated" });
	assert.throws(() => new Graph({ storage }).atom("a0").inserts[0], /invalid stored insertion run/);
});
