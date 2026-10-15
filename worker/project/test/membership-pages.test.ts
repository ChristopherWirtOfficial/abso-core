// Membership by atom number (abso Capacity, spaces.ts PageReader): a writer-backed project answers "is this atom in
// shared at this version" from a page per 256 atoms, and from the atom's events when it was dropped or came back.
// Every atom at every version must answer as the in-memory project does, closure included.

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
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
	return { storage, project: new Project(store, { writerStorage: storage }) };
}

/** Edits on edits, drops that leave atoms a later version needs, and work after them. */
function history(project: Project) {
	project.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }, 0);
	project.record("ann", { "a.txt": "ONE\ntwo\nthree\n" }, 1);
	assert.equal(project.publish("ann", "First", 2).ok, true);
	project.record("ann", { "a.txt": "ONE\nTWO\nthree\n", "b.txt": "b\nmore\n" }, 3);
	assert.equal(project.publish("ann", "Second", 4).ok, true);
	project.record("bob", { "a.txt": "ONE!\nTWO\nthree\n" }, 5);
	assert.equal(project.publish("bob", "Third, on the first", 6).ok, true);
	for (const versions of [[1], [2]])
		try {
			project.drop("ann", versions, `Drop ${versions}`, 7 + versions[0]!);
		} catch {}
	project.record("cy", { "c.txt": "new\n" }, 10);
	assert.equal(project.publish("cy", "Fourth", 11).ok, true);
}

test("every atom at every version is in shared on disk exactly when it is in memory", () => {
	const oracle = new Project(new MemoryStore());
	const { storage, project } = writer();
	history(oracle);
	history(project);
	assert.equal(storage.read('membership:"":pages:meta', "kept"), 1, "a fresh writer keeps the pages");
	const atoms = Array.from({ length: oracle.graph.size }, (_, seq) => oracle.graph.idOfSeq(seq));
	assert.ok(atoms.length > 8, "the history has atoms to ask about");
	let mixed = 0;
	for (let v = 0; v <= oracle.version; v++) {
		const want = oracle.viewAt(v).set;
		const got = project.viewAt(v).set;
		for (const atom of atoms) assert.equal(got.has(atom), want.has(atom), `${atom} at version ${v}`);
	}
	for (const page of storage.entries('membership:"":pages'))
		mixed += (page[1] as number[]).filter((c) => c === -2).length;
	assert.ok(mixed > 0, "the drops leave atoms whose events are read");
});
