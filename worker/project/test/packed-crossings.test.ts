// Packed file layout and lines written across files (abso Capacity). A line can be written in one file under a
// parent written in another: the parent was moved there. When a later move takes the parent on, the line follows
// it without a move of its own. Laid out from packed history, the file must still hold those lines, as the
// in-memory project's does.

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

const C = "const x = 1;\nconst y = 2;\n";

function history(project: Project) {
	let t = 0;
	project.init({ "c.ts": C, "other.ts": "other\n" }, t);
	project.sync("cy");
	project.move("ann", "c.ts", "d.ts", ++t);
	assert.equal(project.publish("ann", "Move c to d", ++t).ok, true);
	// bob adds a line at the end of d.ts: written in d.ts, under a line written in c.ts.
	project.sync("bob");
	project.record("bob", { "d.ts": `${C}const z = 3;\n` }, ++t);
	assert.equal(project.publish("bob", "Add z", ++t).ok, true);
	// dee moves d.ts on to e.ts. bob's line follows its parent there with no move of its own.
	project.sync("dee");
	project.move("dee", "d.ts", "e.ts", ++t);
	project.record("dee", { "other.ts": "other\nmore\n" }, ++t);
	project.sync("idle");
}

const text = (project: Project, agent: string, file: string) =>
	(project.draftOf(agent)?.view ?? project.sharedView()).text(file);

test("a file laid out from packed history keeps lines written in another file under its own lines", () => {
	const oracle = new Project(new MemoryStore());
	const project = writer();
	history(oracle);
	history(project);
	assert.equal(text(oracle, "dee", "e.ts"), `${C}const z = 3;\n`);
	assert.deepEqual(project.files(), oracle.files());
	assert.deepEqual(where(project), where(oracle));
	for (const agent of ["ann", "bob", "cy", "dee", "idle"])
		for (const file of ["c.ts", "d.ts", "e.ts"])
			assert.equal(text(project, agent, file), text(oracle, agent, file), `${agent} ${file}`);
});
