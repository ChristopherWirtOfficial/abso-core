// abso skill: the skill the client carries, and where install
// writes it.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { main } from "../src/main.ts";
import { installSkill, SKILL, skillPath } from "../src/skill.ts";

const dir = mkdtempSync(join(tmpdir(), "abso-skill-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("abso skill", () => {
	it("carries client/skills/abso/SKILL.md word for word", () => {
		assert.equal(SKILL, readFileSync(new URL("../skills/abso/SKILL.md", import.meta.url), "utf8"));
	});

	it("is instructions only: named abso, with no tools to allow", () => {
		const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1];
		assert.ok(front, "the skill starts with its frontmatter");
		assert.match(front, /^name: abso$/m);
		assert.match(front, /^description: .+/m);
		assert.doesNotMatch(SKILL, /allowed-tools/i);
	});

	it("goes to ~/.claude/skills/abso/SKILL.md, or under the skills folder --dir names", () => {
		assert.equal(skillPath(undefined, "/work", "/home/a"), join("/home/a", ".claude", "skills", "abso", "SKILL.md"));
		assert.equal(skillPath("skills", "/work", "/home/a"), join(resolve("/work"), "skills", "abso", "SKILL.md"));
	});

	it("installs, says when it's already current, updates, and leaves the rest of the folder alone", () => {
		const skills = join(dir, "skills");
		const path = skillPath(skills, dir);
		assert.equal(installSkill(path), "installed");
		assert.equal(readFileSync(path, "utf8"), SKILL);
		assert.equal(installSkill(path), "current");
		writeFileSync(join(skills, "abso", "notes.md"), "mine");
		writeFileSync(path, "an older skill");
		assert.equal(installSkill(path), "updated");
		assert.equal(readFileSync(path, "utf8"), SKILL);
		assert.deepEqual(readdirSync(join(skills, "abso")).sort(), ["SKILL.md", "notes.md"]);
	});

	it("runs outside an abso folder, and shows the skill", async () => {
		const run = (...argv: string[]) => main(argv, { cwd: dir, env: {}, write: () => {} });
		const installed = await run("skill", "install", "--dir", "elsewhere");
		assert.equal(installed.exit, 0, installed.stderr);
		assert.match(installed.stdout, /^Installed the abso skill at .*SKILL\.md\. New Claude Code sessions load it\./);
		assert.equal(readFileSync(join(dir, "elsewhere", "abso", "SKILL.md"), "utf8"), SKILL);
		const shown = await run("skill", "show");
		assert.equal(shown.stdout.trimEnd(), SKILL.trimEnd());
		const wrong = await run("skill", "remove");
		assert.notEqual(wrong.exit, 0);
		assert.match(wrong.stderr, /abso skill install \[--dir <skills folder>\] \| abso skill show/);
	});
});
