// Labels (#10): marks on versions of shared ("passed-ci"); a folder can
// follow the newest version with a given label, which is the hook project
// gates need.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "a.txt": "v0\n" }, 0);
	return { project, store };
}

/** Publish versions 1..n, each changing a.txt to "v<n>". */
function publishVersions(project: Project, n: number): void {
	for (let v = 1; v <= n; v++) {
		project.sync("dev");
		project.record("dev", { "a.txt": `v${v}\n` }, v);
		project.publish("dev", `Version ${v}`, v);
	}
}

test("labels mark versions, show in log, and come off", () => {
	const { project } = setup();
	publishVersions(project, 3);
	assert.deepEqual(project.label("ci", "passed-ci", 1, 10), { name: "passed-ci", version: 1, versions: [1] });
	assert.deepEqual(project.label("ci", "passed-ci", undefined, 11), {
		name: "passed-ci",
		version: 3,
		versions: [3, 1],
	});
	project.label("ci", "release", 1, 12);
	assert.deepEqual(project.labels(), { labels: { "passed-ci": [3, 1], release: [1] } });
	assert.deepEqual(project.log().versions.find((v) => v.version === 1)!.labels, ["passed-ci", "release"]);
	// Labelling again does nothing; removing takes it off.
	const before = project.log();
	project.label("ci", "passed-ci", 3, 13);
	assert.deepEqual(project.log(), before);
	project.label("ci", "passed-ci", 3, 14, { remove: true });
	assert.deepEqual(project.labels().labels["passed-ci"], [1]);
});

test("a folder follows the newest version with a label, not the newest version", () => {
	const { project } = setup();
	publishVersions(project, 2);
	project.label("ci", "passed-ci", 1, 10);
	const s = project.sync("gate", { label: "passed-ci" });
	assert.equal(s.version, 1);
	assert.deepEqual(s.files, { "a.txt": "v1\n" });
	// CI passes version 2: the follower moves up; a plain sync goes to the newest.
	project.label("ci", "passed-ci", 2, 11);
	assert.deepEqual(project.sync("gate", { label: "passed-ci" }).files, { "a.txt": "v2\n" });
	publishVersions(project, 3);
	assert.deepEqual(project.sync("gate", { label: "passed-ci" }), { version: 2, files: {}, collisions: [] });
	assert.equal(project.sync("gate").version, 5);
});

test("following a label back is refused when it would strand the agent's own work", () => {
	const { project } = setup();
	publishVersions(project, 2);
	project.label("ci", "passed-ci", 1, 10);
	project.sync("dev");
	project.edit("dev", { file: "a.txt", old: "v2", new: "v2 and more" }, 11);
	assert.throws(
		() => project.sync("dev", { label: "passed-ci" }),
		(e: unknown) => e instanceof ProjectError && e.code === "conflict" && /version 1 doesn't have yet/.test(e.message),
	);
	assert.throws(() => project.sync("dev", { label: "nothing" }), /no version of shared has the label/);
	assert.throws(() => project.label("ci", "bad label", 1, 12), /bad label/);
	assert.throws(() => project.label("ci", "ok", 99, 12), /no version 99/);
});

test("a log with labels and label-following syncs loads back the same", () => {
	const { project, store } = setup();
	publishVersions(project, 2);
	project.label("ci", "passed-ci", 1, 10);
	project.sync("gate", { label: "passed-ci" });
	const again = Project.load(store.entries, new MemoryStore());
	assert.deepEqual(again.labels(), project.labels());
	assert.deepEqual(again.status(), project.status());
});
