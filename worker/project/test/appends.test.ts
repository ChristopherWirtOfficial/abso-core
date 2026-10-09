// Insertions at the same point (#37, the game trial): five builders appended
// their pitches to notes/pitches.md at once, and publishes were refused for
// what was never a real collision. Two pure insertions after the same line
// lose nothing, so they are kept side by side; they still collide when they
// share a real line, create the same file, or one changed what the other
// inserted next to.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

const PITCHES = "# Pitches\n";

function setup(files: Record<string, string> = { "notes/pitches.md": PITCHES }) {
	const project = new Project(new MemoryStore());
	project.init(files, 0);
	const builders = ["b1", "b2", "b3", "b4", "b5"];
	for (const b of builders) project.sync(b);
	return { project, builders };
}

test("five builders appending to the same file at once all publish on the first try, and nothing is lost", () => {
	const { project, builders } = setup();
	builders.forEach((b, i) =>
		project.edit(
			b,
			{ file: "notes/pitches.md", old: "# Pitches\n", new: `# Pitches\n\n## ${b}'s pitch\nIdea number ${i + 1}.\n` },
			1,
		),
	);
	builders.forEach((b, i) => assert.equal(project.publish(b, `${b} pitch`, 2 + i).ok, true, b));
	const text = project.files()["notes/pitches.md"]!;
	for (const [i, b] of builders.entries()) assert.ok(text.includes(`## ${b}'s pitch\nIdea number ${i + 1}.\n`), b);
	assert.equal(text.split("\n").filter((l) => l === "# Pitches").length, 1);
	// Everyone syncs to the same file, with nothing to settle.
	for (const b of builders) assert.deepEqual(project.sync(b).collisions, [], b);
});

test("a publish says what it went on top of that the folder did not have yet", () => {
	const { project } = setup();
	project.edit("b5", { file: "notes/pitches.md", old: "# Pitches\n", new: "# Pitches\nfive\n" }, 1);
	project.publish("b5", "Pitch five", 2);
	project.edit("b3", { file: "notes/pitches.md", old: "# Pitches\n", new: "# Pitches\nthree\n" }, 3);
	assert.deepEqual(project.publish("b3", "Pitch three", 4), {
		ok: true,
		version: 2,
		changes: 1,
		mergedWith: [{ version: 1, agent: "b5", message: "Pitch five" }],
	});
	assert.deepEqual(project.sync("b3").files, { "notes/pitches.md": "# Pitches\nthree\nfive\n" });
});

test("insertions at the same point still collide when they share a real line", () => {
	const { project } = setup({ "a.ts": 'import { x } from "./x.ts";\nrun();\n' });
	project.edit(
		"b1",
		{
			file: "a.ts",
			old: 'import { x } from "./x.ts";\n',
			new: 'import { x } from "./x.ts";\nimport { y } from "./y.ts";\n',
		},
		1,
	);
	project.edit(
		"b2",
		{
			file: "a.ts",
			old: 'import { x } from "./x.ts";\n',
			new: 'import { x } from "./x.ts";\nimport { y } from "./y.ts";\nimport { z } from "./z.ts";\n',
		},
		1,
	);
	project.publish("b1", "y", 2);
	assert.equal(project.publish("b2", "y and z", 3).ok, false);
});

test("two agents creating the same new file still collide", () => {
	const { project } = setup();
	project.edit("b1", { file: "src/game.ts", content: "export const a = 1;\n" }, 1);
	project.edit("b2", { file: "src/game.ts", content: "export const b = 2;\n" }, 1);
	project.publish("b1", "game a", 2);
	assert.equal(project.publish("b2", "game b", 3).ok, false);
});

test("an insertion next to a line the other side changed still collides", () => {
	const { project } = setup({ "notes/pitches.md": "# Pitches\nend\n" });
	project.edit("b1", { file: "notes/pitches.md", old: "# Pitches\n", new: "# Game pitches\n" }, 1);
	project.edit("b2", { file: "notes/pitches.md", old: "# Pitches\n", new: "# Pitches\nmine\n" }, 1);
	project.publish("b1", "Retitle", 2);
	assert.equal(project.publish("b2", "Mine", 3).ok, false);
});

test("a one-line list both sides added to is merged at sync, told, and publishes; no doubled declaration", () => {
	const { project } = setup({ "src/main.ts": "const SYSTEMS = [input, physics];\nrun(SYSTEMS);\n" });
	project.edit("b1", { file: "src/main.ts", old: "[input, physics]", new: "[input, physics, audio]" }, 1);
	project.publish("b1", "Audio system", 2);
	project.edit("b2", { file: "src/main.ts", old: "[input, physics]", new: "[input, physics, render]" }, 3);
	assert.equal(project.publish("b2", "Render system", 4).ok, false);
	const s = project.sync("b2");
	assert.deepEqual(s.collisions, []);
	assert.deepEqual(s.merged, [
		{
			file: "src/main.ts",
			line: 1,
			text: "const SYSTEMS = [input, physics, audio, render];",
			theirs: { agent: "b1", message: "Audio system", version: 1 },
		},
	]);
	assert.equal(project.publish("b2", "Render system", 5).ok, true);
	assert.equal(project.files()["src/main.ts"], "const SYSTEMS = [input, physics, audio, render];\nrun(SYSTEMS);\n");
});

test("news about a collision is dropped once the agent syncs past it; announcements stay", () => {
	const { project } = setup({ "a.ts": "x\n" });
	project.edit("b2", { file: "a.ts", old: "x", new: "y" }, 1);
	project.edit("b4", { file: "a.ts", old: "x", new: "z" }, 1);
	project.publish("b4", "z", 2);
	project.announce("lead", "Stand-up at 16:00.", ["b2"], 3);
	// b2 syncs (the collision is listed there), settles it, and publishes.
	assert.equal(project.sync("b2").collisions.length, 1);
	// The next answer with news has the announcement, and not the collision it already synced past.
	assert.deepEqual(project.record("b2", { "a.ts": "y and z\n" }, 4).news, [
		"Announcement from lead (as claimed): Stand-up at 16:00.",
	]);
	assert.equal(project.publish("b2", "Both", 5).ok, true);
	const next = project.edit("b2", { file: "a.ts", old: "y and z", new: "yz" }, 6);
	assert.deepEqual(next.ok && next.news, []);
});
