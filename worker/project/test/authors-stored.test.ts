// Who wrote what, on a writer-backed project (abso Capacity): tree with authors, a folder's blame and a file's blame
// take each line's writer from the packed layout and each atom's author once. They must answer as the in-memory
// project does, at the head, at an older version and in an agent's draft.

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { blame, folderBlame } from "../blame.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";

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

function history(project: Project) {
	let t = 0;
	project.init({ "src/a.ts": "one\ntwo\nthree\n", "src/b.ts": "b\n", "README.md": "readme\n" }, t);
	project.record("ann", { "src/a.ts": "one\nTWO\nthree\nfour\n" }, ++t);
	assert.equal(project.publish("ann", "Ann's lines", ++t).ok, true);
	project.sync("bob");
	project.record("bob", { "src/b.ts": "b\nbob's\n", "src/c.ts": "new\n" }, ++t);
	assert.equal(project.publish("bob", "Bob's lines", ++t).ok, true);
	project.sync("cy");
	project.record("cy", { "src/a.ts": "one\nTWO\nthree\nfour\nfive\n" }, ++t);
}

test("tree with authors and blame read the same from disk as from memory", () => {
	const oracle = new Project(new MemoryStore());
	const project = writer();
	history(oracle);
	history(project);
	for (const options of [{ authors: true }, { authors: true, version: 1 }, { authors: true, agent: "cy" }])
		assert.deepEqual(project.tree("", options), oracle.tree("", options), JSON.stringify(options));
	assert.deepEqual(project.tree("src", { authors: true }), oracle.tree("src", { authors: true }));
	for (const [folder, version, where] of [
		["", undefined, {}],
		["src", 1, {}],
		["src", undefined, { agent: "cy" }],
	] as const)
		assert.deepEqual(folderBlame(project, folder, version, where), folderBlame(oracle, folder, version, where));
	assert.deepEqual(blame(project, "src/a.ts"), blame(oracle, "src/a.ts"));
	assert.deepEqual(
		blame(project, "src/a.ts", undefined, undefined, undefined, { agent: "cy" }),
		blame(oracle, "src/a.ts", undefined, undefined, undefined, { agent: "cy" }),
	);
	const authors = oracle.tree("", { authors: true }).entries.find((e) => e.name === "src")?.authors ?? [];
	assert.ok(authors.length >= 2, "more than one author wrote src");
});
