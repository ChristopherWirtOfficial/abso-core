// Two spellings of one name never both reach shared (#49): two agents creating README.md and
// readme.md at once, one record naming both, init, a file and a folder with
// one name, and plain git. A clash shared already holds isn't charged to new
// work.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const project = new Project(new MemoryStore());
	project.init({ "x.ts": "x\n" }, 0);
	for (const a of ["alice", "bob", "carol"]) project.sync(a);
	return project;
}

test("two agents creating one name in two spellings: the second push is refused, naming both", () => {
	const p = setup();
	p.record("alice", { "README.md": "# A\n" }, 1);
	p.record("bob", { "readme.md": "# b\n" }, 2);
	assert.equal(p.publish("alice", "readme", 3).ok, true);
	assert.throws(
		() => p.publish("bob", "readme too", 4),
		/readme\.md and README\.md would both be in shared, but they're one file/,
	);
	assert.deepEqual(Object.keys(p.files()).sort(), ["README.md", "x.ts"]);
	// Once bob moves his to the stored spelling, it goes.
	p.sync("bob");
	assert.ok(p.draftOf("bob")!.view.hasFile("README.md"));
});

test("one record naming two spellings, both written, is refused; a rename (one of them null) is not", () => {
	const p = setup();
	assert.throws(
		() => p.record("carol", { "Notes.md": "one\n", "notes.md": "two\n" }, 1),
		/Notes\.md and notes\.md are one file/,
	);
	p.record("carol", { "x.ts": null, "X.ts": "x\n" }, 2);
	p.publish("carol", "capital X", 3);
	assert.deepEqual(Object.keys(p.files()), ["X.ts"]);
});

test("init with two spellings, or a file and a folder of one name, is refused", () => {
	assert.throws(
		() => new Project(new MemoryStore()).init({ "A.ts": "a\n", "a.ts": "b\n" }, 0),
		/init: A\.ts and a\.ts are one file/,
	);
	assert.throws(
		() => new Project(new MemoryStore()).init({ docs: "d\n", "Docs/readme.md": "r\n" }, 0),
		/docs is a file, and Docs\/readme\.md puts a file in a folder of that name/,
	);
});

test("a file and a folder of one name, from two agents, either way round", () => {
	const p = setup();
	p.record("alice", { docs: "notes\n" }, 1);
	p.record("bob", { "Docs/readme.md": "# docs\n" }, 2);
	assert.equal(p.publish("alice", "docs", 3).ok, true);
	assert.throws(
		() => p.publish("bob", "docs folder", 4),
		/Docs\/readme\.md puts a file in folder Docs, but docs is a file of that name/,
	);
	const q = setup();
	q.record("bob", { "Docs/readme.md": "# docs\n" }, 1);
	q.record("alice", { docs: "notes\n" }, 2);
	assert.equal(q.publish("bob", "docs folder", 3).ok, true);
	assert.throws(
		() => q.publish("alice", "docs", 4),
		/docs is a file, but Docs\/readme\.md makes a folder of that name/,
	);
});

test("a land of a named draft is checked too, and plain git", () => {
	const p = setup();
	p.record("alice", { "Plan.md": "a\n" }, 1);
	p.publish("alice", "plan", 2);
	p.switchTo("bob", "side", 3);
	p.record("bob", { "plan.md": "b\n" }, 4, {}, {}, {}, { exactSpelling: true });
	p.publish("bob", "plan in side", 5);
	assert.throws(() => p.land("bob", "land it", 6), /plan\.md and Plan\.md would both be in shared/);
	assert.throws(
		() =>
			p.ingest(
				{
					author: "Robin",
					base: p.version,
					commits: [{ sha: "abcdef1", message: "two", files: { "x.ts": "x\n", "Y.md": "y\n", "y.md": "z\n" } }],
				},
				7,
			),
		/commit abcdef1: Y\.md and y\.md are one file/,
	);
});

test("a clash shared already holds doesn't block work on either file", () => {
	const old = new MemoryStore();
	new Project(old).init({ "a.md": "lower\n", "X.md": "upper\n" }, 0);
	const p = Project.load(JSON.parse(JSON.stringify(old.entries).replaceAll("X.md", "A.md")), new MemoryStore());
	p.sync("alice");
	p.record("alice", { "a.md": "lower, edited\n" }, 1, {}, {}, {}, { exactSpelling: true });
	assert.equal(p.publish("alice", "edit one of them", 2).ok, true);
});

test("with the merge queue, a push that clashes with one queued ahead is refused at queue time", () => {
	const p = new Project(new MemoryStore());
	p.checkerReady = true;
	p.init({ "avcs.json": '{"queue": true}\n' }, 0);
	for (const a of ["alice", "bob"]) p.sync(a);
	p.record("alice", { "README.md": "# A\n" }, 1);
	p.record("bob", { "readme.md": "# b\n" }, 2);
	const first = p.publish("alice", "readme", 3);
	assert.ok(first.ok && "queued" in first);
	assert.throws(() => p.publish("bob", "readme too", 4), /readme\.md and README\.md would both be in shared/);
	assert.equal(p.queue().items.length, 1);
	// Once the queued one lands, shared holds one spelling (abso issue 68).
	p.queueLand(p.queue().items[0]!.id, 5);
	assert.deepEqual(
		Object.keys(p.files()).filter((f) => f.toLowerCase() === "readme.md"),
		["README.md"],
	);
});
