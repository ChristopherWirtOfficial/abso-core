// Each version's changed files kept as it lands (abso Capacity, version-files.ts): a writer-backed project's log,
// path histories, shows and compares match the in-memory project's through edits, new and removed files, a line
// taken out and put back with the same text, moves and a drop.

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectStore } from "../project-types.ts";
import { countedVersion } from "../version-files.ts";

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

function history(project: Project) {
	let t = 0;
	const publish = (agent: string, files: Record<string, string | null>, message: string) => {
		project.record(agent, files, ++t);
		assert.equal(project.publish(agent, message, ++t).ok, true, message);
	};
	project.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "bee\n", "gone.txt": "soon\n" }, t);
	publish("ann", { "a.txt": "one\nTWO\nthree\n" }, "Edit a");
	publish("ann", { "c.txt": "new file\n" }, "Make c");
	publish("ann", { "gone.txt": null }, "Remove gone");
	publish("ann", { "b.txt": "" }, "Empty b");
	publish("ann", { "b.txt": "bee\n" }, "Same text back in b");
	project.move("ann", "c.txt", "d.txt", ++t);
	assert.equal(project.publish("ann", "Move c to d", ++t).ok, true);
	publish("bob", { "d.txt": "new file\nmore\n" }, "Edit d");
	publish("cy", { "e.txt": "e\n" }, "Make e");
	const dropped = project.drop("cy", [project.version], "Drop e", ++t);
	assert.equal(dropped.ok, true);
	publish("bob", { "a.txt": "one\nTWO\nthree\nfour\n" }, "Last");
}

test("kept version files match the in-memory project's log, paths and shows", () => {
	const oracle = new Project(new MemoryStore());
	const { storage, project } = writer();
	history(oracle);
	history(project);
	assert.equal(countedVersion(storage), oracle.version);
	assert.deepEqual(project.log({ limit: 100 }), oracle.log({ limit: 100 }));
	for (const path of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "gone.txt"])
		assert.deepEqual(project.log({ limit: 100, path }), oracle.log({ limit: 100, path }), path);
	for (let v = 0; v <= oracle.version; v++) assert.deepEqual(project.show(v), oracle.show(v), `version ${v}`);
	// A compare reads the kept lists for the versions between (version-log.ts): both ways, and across the drop.
	for (const [from, to] of [
		[0, oracle.version],
		[oracle.version, 0],
		[2, 7],
		[5, 9],
		[3, 3],
	] as const)
		assert.deepEqual(project.compare(from, to), oracle.compare(from, to), `compare ${from} to ${to}`);
});
