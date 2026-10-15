// The files a draft's view can't take from its base (abso Capacity, touchedBeyond): everything the view holds beyond
// the base counts, not only the draft's own atoms. A view's set is closed under dependencies, so an atom the agent
// holds can bring in work the base lacks, as a publish's tie does. Core 235 counted the agent's atoms alone and showed
// such files at the older base (Testing's typescript-rs diff for cloud-ts-01).

import assert from "node:assert/strict";
import { test } from "node:test";
import { touchedBeyond, touchedFiles } from "../collisions.ts";
import { MemoryStore, Project } from "../project.ts";

test("files changed by work the agent's atoms depend on count, not only the atoms' own", () => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "a\n", "b.txt": "b\n" }, 0);
	project.record("ann", { "b.txt": "b\nmore\n" }, 1);
	assert.equal(project.publish("ann", "More b", 2).ok, true);
	const graph = project.graph;
	const tie = graph.idOfSeq(graph.size - 1);
	assert.deepEqual([...graph.filesOf(tie)], [], "a tie writes no files itself");
	const base = project.viewAt(0);
	const view = project.viewAt(1);
	// Counted alone, the tie touches nothing, and b.txt would be taken from version 0.
	assert.deepEqual([...touchedFiles(graph, [tie], [base, view])], []);
	assert.deepEqual([...(touchedBeyond(graph, base.set, [tie], [base, view]) ?? [])], ["b.txt"]);
	// Counted from version 1, which holds the change, nothing is beyond it.
	assert.deepEqual([...(touchedBeyond(graph, view.set, [tie], [view]) ?? [])], []);
});

test("nothing is shared when anything beyond the base moves lines", () => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }, 0);
	project.move("ann", "a.txt", "c.txt", 1);
	assert.equal(project.publish("ann", "Move a to c", 2).ok, true);
	const graph = project.graph;
	const tie = graph.idOfSeq(graph.size - 1);
	const base = project.viewAt(0);
	assert.equal(touchedBeyond(graph, base.set, [tie], [base, project.viewAt(1)]), undefined);
});
