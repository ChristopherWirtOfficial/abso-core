// File attributes (#27): empty files, the executable bit and symbolic links
// live in the graph as claims of their own, so they travel through publish,
// sync, drafts and plain-git intake, and collide only with the same attribute.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store);
	project.init({ "run.sh": "echo hi\n", "pkg/__init__.py": "", "notes.md": "a\n" }, 0, {
		"run.sh": { exec: true },
		latest: { link: "run.sh" },
	});
	return { project, store };
}

test("init keeps empty files, executable files and links", () => {
	const { project } = setup();
	const s = project.sync("ann");
	assert.deepEqual(s.files, { latest: "", "notes.md": "a\n", "pkg/__init__.py": "", "run.sh": "echo hi\n" });
	assert.deepEqual(s.modes, { latest: { exec: false, link: "run.sh" }, "run.sh": { exec: true, link: null } });
	assert.deepEqual(project.modes(), { latest: { link: "run.sh" }, "run.sh": { exec: true } });
});

test("an empty file can be made, pushed, pulled and removed", () => {
	const { project } = setup();
	project.sync("ann");
	project.sync("bob");
	project.edit("ann", { file: ".gitkeep", content: "" }, 1);
	project.record("ann", { "notes.md": "" }, 1); // emptied, not deleted
	project.publish("ann", "Empty files", 2);
	assert.deepEqual(project.sync("bob").files, { ".gitkeep": "", "notes.md": "" });
	project.record("bob", { ".gitkeep": null }, 3);
	project.publish("bob", "Drop gitkeep", 4);
	assert.equal(".gitkeep" in project.files(), false);
	assert.equal(project.files()["notes.md"], "");
});

test("the executable bit and links change on their own, and show up in pull, show and diff", () => {
	const { project } = setup();
	project.sync("ann");
	project.sync("bob");
	project.record("ann", {}, 1, { "notes.md": { exec: true }, latest: { link: "notes.md" } });
	assert.deepEqual(project.diff("ann").files, [
		{
			path: "latest",
			before: "",
			after: "",
			mode: { before: { exec: false, link: "run.sh" }, after: { exec: false, link: "notes.md" } },
		},
		{
			path: "notes.md",
			before: "a\n",
			after: "a\n",
			mode: { before: { exec: false, link: null }, after: { exec: true, link: null } },
		},
	]);
	project.publish("ann", "Modes", 2);
	const b = project.sync("bob");
	assert.deepEqual(b.files, {});
	assert.deepEqual(b.modes, { latest: { exec: false, link: "notes.md" }, "notes.md": { exec: true, link: null } });
	assert.equal(project.show(1).diff.length, 2);
	// Recording the same modes again changes nothing.
	assert.deepEqual(project.record("bob", {}, 3, { "notes.md": { exec: true } }).changed, []);
});

test("two drafts collide on the same attribute only", () => {
	const { project } = setup();
	project.sync("ann");
	project.sync("bob");
	project.record("ann", {}, 1, { "notes.md": { exec: true } });
	project.edit("bob", { file: "notes.md", old: "a\n", new: "b\n" }, 1); // lines, not the bit: no collision
	project.record("bob", {}, 1, { "run.sh": { exec: false } });
	project.publish("ann", "exec notes", 2);
	assert.equal(project.publish("bob", "lines and run.sh", 3).ok, true);

	project.sync("ann");
	project.sync("bob");
	// Both set run.sh's bit (bob cleared it above), so both write the same attribute.
	project.record("ann", {}, 4, { "run.sh": { exec: true } });
	project.record("bob", {}, 4, { "run.sh": { exec: true } });
	project.record("bob", { "run.sh": "echo bye\n" }, 4);
	project.publish("ann", "run.sh executable again", 5);
	const refused = project.publish("bob", "run.sh plain", 6);
	assert.equal(refused.ok, false);
	const c = !refused.ok ? refused.collisions.find((x) => x.kind === "attribute") : undefined;
	assert.deepEqual(c && { kind: c.kind, name: c.name, file: c.file, yours: c.yours.text, theirs: c.theirs.text }, {
		kind: "attribute",
		name: "exec",
		file: "run.sh",
		yours: "1",
		theirs: "1",
	});
	// After a sync bob has seen ann's; publishing settles it.
	project.sync("bob");
	assert.equal(project.publish("bob", "Keep it executable", 8).ok, true);
	assert.deepEqual(project.modes()["run.sh"], { exec: true });
});

test("restore puts the mode back, and plain-git intake reads modes", () => {
	const { project, store } = setup();
	project.sync("ann");
	project.record("ann", {}, 1, { "run.sh": { exec: false } });
	assert.deepEqual(project.restore("ann", ["run.sh"], 2), {
		files: { "run.sh": "echo hi\n" },
		dropped: 1,
		modes: { "run.sh": { exec: true, link: null } },
	});

	const files = { "run.sh": "echo hi\n", "pkg/__init__.py": "", "notes.md": "a\n", latest: "", "tool.sh": "x\n" };
	const answer = project.ingest(
		{
			author: "p",
			base: 0,
			commits: [
				{
					sha: "abcdef12",
					message: "tool",
					files,
					modes: { "run.sh": { exec: true }, latest: { link: "run.sh" }, "tool.sh": { exec: true } },
				},
			],
		},
		3,
	);
	assert.equal(answer.landed, true);
	assert.deepEqual(project.modes(), {
		latest: { link: "run.sh" },
		"run.sh": { exec: true },
		"tool.sh": { exec: true },
	});
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).modes(), project.modes());
});
