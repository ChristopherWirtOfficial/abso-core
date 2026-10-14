// A version without others: the files of one version of shared with some earlier versions left out. A read:
// shared and its log never change. Refused, naming the chain, when a version kept builds on one left out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";
import { treeHash } from "../tree.ts";

const START = { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nbeta\n" };

function setup() {
	const store = new MemoryStore();
	const project = new Project(store, { hasBlob: () => true });
	project.init(START, 0);
	for (const a of ["ann", "bob", "cat"]) project.sync(a);
	return { project, store };
}

/** ann publishes v1 (a.ts), bob v2 (b.ts), cat v3 (a new c.ts): three versions that don't build on each other. */
function threeVersions(project: Project): void {
	project.edit("ann", { file: "a.ts", old: "two", new: "TWO" }, 1);
	project.publish("ann", "Shout two", 2);
	project.edit("bob", { file: "b.ts", old: "beta", new: "BETA" }, 3);
	project.publish("bob", "Shout beta", 4);
	project.record("cat", { "c.ts": "gamma\n" }, 5);
	project.publish("cat", "Add c", 6);
}

const badRequest = (f: () => unknown): string => {
	try {
		f();
	} catch (e) {
		if (e instanceof ProjectError && e.code === "bad-request") return e.message;
		throw e;
	}
	return "no error";
};

test("leaving out an independent version takes only its change out; the others stay as they are", () => {
	const { project, store } = setup();
	threeVersions(project);
	const entries = store.entries.length;
	const answer = project.without(3, [1]);
	assert.equal(answer.ok, true);
	assert.ok(answer.ok);
	assert.deepEqual(answer.without, [{ version: 1, agent: "ann", message: "Shout two" }]);
	assert.deepEqual(answer.files, [{ path: "a.ts", before: "one\nTWO\nthree\n", after: "one\ntwo\nthree\n" }]);
	assert.equal(
		answer.tree,
		treeHash({ files: { "a.ts": "one\ntwo\nthree\n", "b.ts": "alpha\nBETA\n", "c.ts": "gamma\n" } }),
	);
	// Shared is unchanged: same version, same files, nothing written to the log.
	assert.equal(project.version, 3);
	assert.deepEqual(project.files(), { "a.ts": "one\nTWO\nthree\n", "b.ts": "alpha\nBETA\n", "c.ts": "gamma\n" });
	assert.equal(store.entries.length, entries);
	// Two left out at once.
	const two = project.without(3, [3, 1]);
	assert.ok(two.ok);
	assert.deepEqual(
		two.without.map((w) => w.version),
		[1, 3],
	);
	assert.deepEqual(
		two.files.map((f) => [f.path, f.after]),
		[
			["a.ts", "one\ntwo\nthree\n"],
			["c.ts", null],
		],
	);
});

test("the same ask gives the same answer, and shared moving on doesn't change it", () => {
	const { project } = setup();
	threeVersions(project);
	const first = project.without(3, [2]);
	assert.deepEqual(project.without(3, [2]), first);
	project.sync("ann");
	project.edit("ann", { file: "c.ts", old: "gamma", new: "GAMMA" }, 7);
	project.publish("ann", "Shout gamma", 8);
	assert.deepEqual(project.without(3, [2]), first);
	// Asked of the newer version, the newer change is in it.
	const later = project.without(4, [2]);
	assert.ok(later.ok && first.ok);
	assert.notEqual(later.tree, first.tree);
});

test("leaving out a version a kept one builds on is refused, with the chain, the files and the wider set", () => {
	const { project, store } = setup();
	threeVersions(project);
	project.sync("cat");
	project.edit("cat", { file: "a.ts", old: "TWO", new: "TWO!" }, 7);
	project.publish("cat", "Louder", 8); // v4 builds on v1
	project.sync("bob");
	project.edit("bob", { file: "a.ts", old: "TWO!", new: "TWO!!" }, 9);
	project.publish("bob", "Louder still", 10); // v5 builds on v4
	const entries = store.entries.length;
	const refused = project.without(5, [1]);
	assert.deepEqual(refused, {
		ok: false,
		version: 5,
		without: [{ version: 1, agent: "ann", message: "Shout two" }],
		dependents: [
			{ version: 4, agent: "cat", message: "Louder", needs: [{ version: 1, files: ["a.ts"] }] },
			{ version: 5, agent: "bob", message: "Louder still", needs: [{ version: 4, files: ["a.ts"] }] },
		],
		suggestion: [1, 4, 5],
	});
	assert.equal(store.entries.length, entries);
	assert.equal(project.version, 5);
	// The suggestion, asked for, works; it's never applied without being asked.
	const wider = project.without(5, refused.ok ? [] : refused.suggestion);
	assert.ok(wider.ok);
	assert.deepEqual(wider.files, [{ path: "a.ts", before: "one\nTWO!!\nthree\n", after: "one\ntwo\nthree\n" }]);
	// Before the dependent version, leaving it out is fine.
	assert.equal(project.without(3, [1]).ok, true);
});

test("a deletion left out brings the lines back; a rename left out keeps the old name; a move left out puts lines back", () => {
	const { project } = setup();
	project.edit("ann", { file: "a.ts", old: "two\n", new: "" }, 1);
	project.publish("ann", "No two", 2);
	project.record("bob", { "b.ts": null, "c.ts": START["b.ts"] }, 3);
	project.publish("bob", "Rename b to c", 4);
	project.sync("cat");
	project.move("cat", "a.ts", "src/a.ts", 5);
	project.publish("cat", "Move a into src", 6);
	assert.deepEqual(project.files(), { "src/a.ts": "one\nthree\n", "c.ts": "alpha\nbeta\n" });

	const noDelete = project.without(3, [1]);
	assert.ok(noDelete.ok);
	assert.deepEqual(
		noDelete.files.map((f) => [f.path, f.after]),
		[["src/a.ts", "one\ntwo\nthree\n"]],
	);
	const noRename = project.without(3, [2]);
	assert.ok(noRename.ok);
	assert.deepEqual(
		noRename.files.map((f) => [f.path, f.before, f.after]),
		[
			["b.ts", null, "alpha\nbeta\n"],
			["c.ts", "alpha\nbeta\n", null],
		],
	);
	const noMove = project.without(3, [3]);
	assert.ok(noMove.ok);
	assert.deepEqual(
		noMove.files.map((f) => [f.path, f.after]),
		[
			["a.ts", "one\nthree\n"],
			["src/a.ts", null],
		],
	);
});

test("a binary file's change and an executable bit left out go back to what they were", () => {
	const A = "a".repeat(64);
	const B = "b".repeat(64);
	const store = new MemoryStore();
	const project = new Project(store, { hasBlob: () => true });
	project.init({ "run.sh": "echo hi\n" }, 0, {}, { "logo.png": A });
	project.sync("ann");
	project.record("ann", {}, 1, {}, { "logo.png": B });
	project.publish("ann", "New logo", 2);
	project.record("ann", {}, 3, { "run.sh": { exec: true } });
	project.publish("ann", "Make run.sh runnable", 4);
	const noLogo = project.without(2, [1]);
	assert.ok(noLogo.ok);
	assert.deepEqual(
		noLogo.files.map((f) => [f.path, f.blob]),
		[["logo.png", { before: B, after: A }]],
	);
	const noExec = project.without(2, [2]);
	assert.ok(noExec.ok);
	assert.deepEqual(
		noExec.files.map((f) => [f.path, f.mode?.after.exec ?? false]),
		[["run.sh", false]],
	);
});

test("versions it can't leave out are refused plainly", () => {
	const { project } = setup();
	threeVersions(project);
	assert.equal(project.drop("cat", [2], "Undo beta", 7).ok, true); // v4 drops v2
	assert.match(
		badRequest(() => project.without(3, [4])),
		/comes after version 3/,
	);
	assert.match(
		badRequest(() => project.without(4, [0])),
		/version 0 is the start/,
	);
	assert.match(
		badRequest(() => project.without(4, [4])),
		/is a drop/,
	);
	assert.match(
		badRequest(() => project.without(4, [2])),
		/isn't in version 4: version 4 dropped it/,
	);
	assert.match(
		badRequest(() => project.without(4, [])),
		/versions to leave out/,
	);
	// Before the drop, it's there to leave out.
	assert.equal(project.without(3, [2]).ok, true);
});
