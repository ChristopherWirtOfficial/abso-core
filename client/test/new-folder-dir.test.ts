import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newFolderDir } from "../src/state-dir.ts";

/** A Claude config folder with these mods installed, each at this version. */
function claudeWith(mods: Record<string, string>): { CLAUDE_CONFIG_DIR: string } {
	const dir = mkdtempSync(join(tmpdir(), "abso-claude-"));
	for (const [name, version] of Object.entries(mods)) {
		const mod = join(dir, "skills", name);
		mkdirSync(mod, { recursive: true });
		writeFileSync(join(mod, ".avcs-install.json"), JSON.stringify({ mod: name, version }));
	}
	return { CLAUDE_CONFIG_DIR: dir };
}

test("a new folder gets .abso when no mod is installed, or every installed mod knows it", () => {
	assert.equal(newFolderDir(claudeWith({})), ".abso");
	assert.equal(newFolderDir(claudeWith({ avcs: "0.2.0+abc1234", "avcs-view": "0.2.0" })), ".abso");
	assert.equal(newFolderDir(claudeWith({ abso: "0.3.1.dirty" })), ".abso");
});

test("a new folder keeps .avcs while any installed mod is older than the rename", () => {
	assert.equal(newFolderDir(claudeWith({ avcs: "0.1.0+2ecf1a7" })), ".avcs");
	assert.equal(newFolderDir(claudeWith({ avcs: "0.2.0", "avcs-view": "0.1.0" })), ".avcs");
	assert.equal(newFolderDir(claudeWith({ avcs: "unreadable" })), ".avcs");
});
