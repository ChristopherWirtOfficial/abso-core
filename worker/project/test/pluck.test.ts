// Pluck (#27): take some versions of a named draft into shared, checked for
// collisions like a land. The draft stays as it is; landing it later brings
// in only what's left.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const START = {
	"a.ts": "export function size(x: string) {\n  return x.length;\n}\n",
	"b.ts": 'import { size } from "./a.ts";\nexport const n = 1;\n',
};

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init(START, 0);
	project.sync("lead");
	project.switchTo("ann", "feature", 1);
	return { project, store };
}

test("pluck one version of a draft; landing the draft later brings the rest", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.ts", old: "x.length", new: "x.length + 0" }, 2);
	project.publish("ann", "Body tweak", 3); // feature v1
	project.edit("ann", { file: "b.ts", old: "n = 1", new: "n = 2" }, 4);
	project.publish("ann", "Two", 5); // feature v2
	const plucked = project.pluck("lead", "feature", [2], "Just the two", 6);
	assert.deepEqual(plucked, {
		ok: true,
		version: 1,
		changes: 2,
		plucked: [{ version: 2, agent: "ann", message: "Two" }],
	});
	assert.equal(project.files()["b.ts"], 'import { size } from "./a.ts";\nexport const n = 2;\n');
	assert.equal(project.files()["a.ts"], START["a.ts"]);
	const landed = project.land("ann", "The rest", 7);
	assert.equal(landed.ok, true);
	assert.equal(project.files()["a.ts"], START["a.ts"].replace("x.length", "x.length + 0"));
});

test("a version that builds on another is refused with what it needs, unless that comes too", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.ts", old: "x.length", new: "x.length * 2" }, 2);
	project.publish("ann", "Double", 3); // v1
	project.edit("ann", { file: "a.ts", old: "x.length * 2", new: "x.length * 3" }, 4);
	project.publish("ann", "Triple", 5); // v2 builds on v1's line
	assert.deepEqual(project.pluck("lead", "feature", [2], "Triple only", 6), {
		ok: false,
		needs: [{ version: 1, agent: "ann", message: "Double" }],
		collisions: [],
	});
	const both = project.pluck("lead", "feature", [2], "Triple", 6, { withDependencies: true });
	assert.deepEqual(both.ok && both.plucked.map((p) => p.version), [1, 2]);
	assert.match(project.files()["a.ts"]!, /x\.length \* 3/);
});

test("a pluck that collides with newer shared work is refused like a land", () => {
	const { project } = setup();
	project.edit("ann", { file: "b.ts", old: "n = 1", new: "n = 2" }, 2);
	project.publish("ann", "Two", 3);
	project.edit("lead", { file: "b.ts", old: "n = 1", new: "n = 3" }, 4);
	project.publish("lead", "Three", 5);
	const refused = project.pluck("lead", "feature", [1], "Two", 6);
	assert.equal(refused.ok, false);
	assert.equal(!refused.ok && refused.collisions[0]!.kind, "lines");
});

test("the rest of a draft lands without colliding with its own plucked definition change", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.ts", old: "size(x: string)", new: "size(x: string, y = 0)" }, 2);
	project.publish("ann", "Size takes y", 3); // v1 changes the definition
	project.edit("ann", { file: "b.ts", old: "n = 1", new: 'n = size("ab", 1)' }, 4);
	project.publish("ann", "Use size with y", 5); // v2 uses it
	assert.equal(project.pluck("lead", "feature", [1], "Size takes y", 6).ok, true);
	assert.equal(project.land("ann", "Use it", 7).ok, true);
});

test("bad plucks are plain errors; a log with a pluck loads back the same", () => {
	const { project, store } = setup();
	project.edit("ann", { file: "b.ts", old: "n = 1", new: "n = 2" }, 2);
	project.publish("ann", "Two", 3);
	assert.throws(() => project.pluck("lead", "nope", [1], "x", 4), /no named draft/);
	assert.throws(() => project.pluck("lead", "feature", [5], "x", 4), /no version 5/);
	assert.throws(() => project.pluck("lead", "feature", [1], "", 4), /message/);
	project.pluck("lead", "feature", [1], "Two", 4);
	assert.throws(() => project.pluck("lead", "feature", [1], "Again", 5), /nothing that shared doesn't have/);
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.files(), project.files());
	assert.deepEqual(again.status(), project.status());
});
