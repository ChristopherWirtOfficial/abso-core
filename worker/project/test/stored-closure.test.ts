// Shared's closure kept on disk (abso Capacity, spaces.ts indexClosure): a writer-backed project answers every
// version as the in-memory one does, through drops that leave atoms a later version still needs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isClosedSet, storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";
import { addVersion, closureIndexed, indexClosure, Membership } from "../spaces.ts";

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

/** The same history on both: edits on top of edits, then drops of the earlier ones, then more. */
function history(project: Project) {
	project.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }, 0);
	project.record("ann", { "a.txt": "ONE\ntwo\nthree\n" }, 1);
	assert.equal(project.publish("ann", "First", 2).ok, true);
	project.record("ann", { "a.txt": "ONE\nTWO\nthree\n", "b.txt": "b\nmore\n" }, 3);
	assert.equal(project.publish("ann", "Second", 4).ok, true);
	project.record("bob", { "a.txt": "ONE!\nTWO\nthree\n" }, 5);
	assert.equal(project.publish("bob", "Third, on the first", 6).ok, true);
	const answers: unknown[] = [];
	for (const versions of [[1], [2]])
		try {
			answers.push(project.drop("ann", versions, `Drop ${versions}`, 7 + versions[0]!));
		} catch (error) {
			answers.push(String(error));
		}
	project.record("cy", { "c.txt": "new\n" }, 10);
	assert.equal(project.publish("cy", "Fourth", 11).ok, true);
	return answers;
}

test("every version reads the same from the stored closure as from memory", () => {
	const oracle = new Project(new MemoryStore());
	const { storage, project } = writer();
	assert.deepEqual(history(project), history(oracle));
	assert.equal(closureIndexed(storage), oracle.version);
	for (let v = 0; v <= oracle.version; v++) {
		const want = oracle.viewAt(v);
		const got = project.viewAt(v);
		assert.ok(isClosedSet(got.set), `version ${v}'s set is known closed`);
		assert.deepEqual(got.files(), want.files(), `version ${v}`);
		assert.deepEqual([...got.set].sort(), [...want.set].sort(), `version ${v}'s atoms`);
	}
	assert.deepEqual(project.files(), oracle.files());
});

test("an atom only a published one needs is in the closure until nothing in shared needs it", () => {
	const storage = new SqlState();
	const membership = new Membership(storage);
	const shared = membership.shared;
	// a1 was never published (a discarded draft atom); a2, published, builds on it.
	const deps: Record<string, string[]> = { a0: [], a1: ["a0"], a2: ["a1"], a3: ["a0"] };
	const graph = {
		atom: (id: string) => ({ deps: deps[id]!, seq: Number(id.slice(1)) }),
		*eachDependentOf(id: string) {
			for (const [atom, list] of Object.entries(deps)) if (list.includes(id)) yield atom;
		},
	};
	const version = (v: number, atoms: string[], dropped?: string[]) => {
		addVersion(shared, { version: v, agent: "w", message: `v${v}`, time: v, atoms, ...(dropped ? { dropped } : {}) });
		indexClosure(storage, shared, graph);
	};
	const at = (v: number) => [...membership.at(shared, v)].sort();
	version(0, ["a0"]);
	version(1, ["a2"]);
	version(2, ["a3"]);
	version(3, [], ["a2"]);
	assert.deepEqual(at(0), ["a0"]);
	assert.deepEqual(at(1), ["a0", "a1", "a2"], "a1 is in because a2 needs it");
	assert.deepEqual(at(2), ["a0", "a1", "a2", "a3"]);
	assert.deepEqual(at(3), ["a0", "a3"], "dropping a2 takes a1 out too");
	assert.equal(membership.at(shared, 1).has("a1"), true);
	assert.equal(membership.at(shared, 3).has("a1"), false);
	for (let v = 0; v <= 3; v++) assert.ok(isClosedSet(membership.at(shared, v)));
	storage.db.close();
});
