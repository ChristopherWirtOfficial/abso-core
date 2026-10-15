// A draft's view takes its base view's layout of every file the draft doesn't touch (abso Capacity, View.shareFiles).
// On a writer-backed project every agent's view must still read every file as the in-memory project does: a draft
// that edits lines moved into another file by a published move, one that deletes such a line, one that only sets an
// attribute, and one that moves lines itself (which shares nothing).

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
	return new Project(store, { writerStorage: storage });
}

const AREA = "export function area(r: number) {\n  const pi = 3.14;\n  return pi * r * r;\n}\n";
const FILES = {
	"src/shapes.ts": `// shapes\n${AREA}\nexport function other() {\n  return 1;\n}\n`,
	"src/geometry.ts": "// geometry\n",
	"src/plain.ts": "one\ntwo\nthree\n",
	"run.sh": "echo hi\n",
	"README.md": "readme\n",
};

function history(project: Project) {
	let t = 0;
	project.init(FILES, t);
	// ann moves area() into geometry.ts and publishes: its lines were written in shapes.ts.
	project.edit("ann", { file: "src/shapes.ts", old: AREA, new: "" }, ++t);
	project.edit("ann", { file: "src/geometry.ts", content: `// geometry\n${AREA}` }, ++t);
	assert.equal(project.publish("ann", "Move area to geometry", ++t).ok, true);
	for (const agent of ["bob", "cy", "dee", "eve", "fay"]) project.sync(agent);
	// bob edits a moved line, cy deletes one, dee touches only plain.ts, eve sets an attribute, fay moves lines.
	project.edit("bob", { file: "src/geometry.ts", old: "3.14", new: "Math.PI" }, ++t);
	project.edit("cy", { file: "src/geometry.ts", old: "  const pi = 3.14;\n", new: "" }, ++t);
	project.record("dee", { "src/plain.ts": "one\nTWO\nthree\n" }, ++t);
	project.record("eve", {}, ++t, { "run.sh": { exec: true } });
	project.edit("fay", { file: "src/plain.ts", old: "one\ntwo\nthree\n", new: "" }, ++t);
	project.edit("fay", { file: "src/moved.ts", content: "one\ntwo\nthree\n" }, ++t);
}

const read = (project: Project, agent: string) => {
	const view = project.draftOf(agent)!.view;
	const out: Record<string, unknown> = {};
	for (const path of view.paths()) out[path] = [view.text(path), view.attrs(path), view.lines(path).map((l) => l.atom)];
	return out;
};

test("every agent's view reads every file as the in-memory project's, with files shared from the base", () => {
	const oracle = new Project(new MemoryStore());
	const project = writer();
	history(oracle);
	history(project);
	for (const agent of ["ann", "bob", "cy", "dee", "eve", "fay"]) {
		// Twice: the second read takes the shared layouts the first one made.
		assert.deepEqual(read(project, agent), read(oracle, agent), agent);
		assert.deepEqual(read(project, agent), read(oracle, agent), `${agent} again`);
	}
	assert.match(String(read(oracle, "bob")["src/geometry.ts"]), /Math\.PI/);
	assert.doesNotMatch(String(read(oracle, "cy")["src/geometry.ts"]), /const pi/);
	assert.deepEqual(project.tree("", { agent: "cy", authors: true }), oracle.tree("", { agent: "cy", authors: true }));
});
