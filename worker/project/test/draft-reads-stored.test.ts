// Reads of agents' drafts on a writer-backed project (abso Capacity): where and draft collisions find files and
// lines by line number, take moves from the draft's base, and gather each draft's claimants once among all the
// drafts. They must answer as the in-memory project does: drafts that edit, delete a whole file, collide on a line,
// define the same name, and sit on bases before and after a move.

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";
import { where } from "../where.ts";

function writer() {
	const storage = new SqlState();
	const entries = storedArray<Entry>(storage, "canonical-log");
	const store: ProjectStore = {
		append(batch) {
			for (const entry of batch) entries.push(entry);
		},
	};
	return new Project(store, { writerStorage: storage });
}

const big = Array.from({ length: 300 }, (_, i) => `generated ${i}\n`).join("");

function history(project: Project) {
	let t = 0;
	project.init({ "a.ts": "one\ntwo\nthree\nfour\n", "big.txt": big, "c.ts": "const x = 1;\n" }, t);
	// One agent's base is before a move, the others' after it.
	project.sync("old");
	project.record("old", { "a.ts": "one\ntwo\nthree\nfour\nfive\n" }, ++t);
	project.move("mover", "c.ts", "d.ts", ++t);
	assert.equal(project.publish("mover", "Move c to d", ++t).ok, true);
	project.record("ann", { "a.ts": "one\nTWO\nthree\nfour\n", "d.ts": "const x = 2;\n" }, ++t);
	project.record("bob", { "a.ts": "one\nTwo\nthree\nfour\n", "big.txt": null }, ++t);
	project.record("cy", { "e.ts": "export function f() {}\n" }, ++t);
	project.record("dee", { "e.ts": "export function f() { return 1; }\n" }, ++t);
	project.sync("idle");
}

test("where and draft collisions on a stored writer match the in-memory project's", () => {
	const oracle = new Project(new MemoryStore());
	const project = writer();
	history(oracle);
	history(project);
	const expected = where(oracle);
	assert.ok(expected.files["big.txt"], "bob's deleted file is listed");
	assert.deepEqual(where(project), expected);
	const collisions = oracle.collisions();
	assert.ok(collisions.collisions.length > 0, "ann and bob collide on a.ts");
	assert.deepEqual(project.collisions(), collisions);
	assert.deepEqual(project.collisions({ file: "a.ts" }), oracle.collisions({ file: "a.ts" }));
});
