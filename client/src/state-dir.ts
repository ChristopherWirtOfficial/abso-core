// Where abso keeps its state (the rename from avcs). Reading takes .abso/ first, then .avcs/, so a folder in
// either works. A new folder is made with .abso/ unless an edit mod installed here is from before the rename:
// such a mod looks only for .avcs/config.json, and would stop recording a .abso/ folder's edits without a word.
// So a new folder gets .avcs/ while any installed mod is older than MOD_KNOWS_ABSO, and .abso/ otherwise.
// The user's files are written to ~/.abso/ (an older client that can't find them says so: it isn't silent).
// Nothing here imports from the rest of the client, so any module can use this.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = ".abso";
export const OLD_STATE_DIR = ".avcs";
const STATE_DIRS = [STATE_DIR, OLD_STATE_DIR] as const;

/** A folder's state folder: whichever has a config.json (.abso first), else whichever exists, else the new folder's name (newFolderDir). */
export function stateDir(root: string): string {
	for (const name of STATE_DIRS) if (existsSync(join(root, name, "config.json"))) return join(root, name);
	for (const name of STATE_DIRS) if (existsSync(join(root, name))) return join(root, name);
	return join(root, newFolderDir());
}

/** The first mod version whose hooks look for .abso/config.json as well as .avcs/config.json. */
export const MOD_KNOWS_ABSO = [0, 2, 0] as const;

/** Every name a mod has been installed under, in Claude Code's skills folder. */
const MOD_NAMES = ["avcs", "avcs-view", "abso", "abso-view"] as const;

function versionAtLeast(version: string, min: readonly number[]): boolean {
	const parts = version.split("+")[0]!.split(".").map(Number);
	for (let i = 0; i < min.length; i++) {
		const have = parts[i] ?? 0;
		if (have !== min[i]) return have > min[i]!;
	}
	return true;
}

/** What a new folder is made with: .abso, unless an installed mod is older than the rename (see the top). */
export function newFolderDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const skills = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills");
	for (const name of MOD_NAMES) {
		if (!existsSync(join(skills, name))) continue; // not installed
		let version: unknown;
		try {
			version = (JSON.parse(readFileSync(join(skills, name, ".avcs-install.json"), "utf8")) as { version?: unknown })
				.version;
		} catch {
			return OLD_STATE_DIR; // installed, but no readable record: count it as old
		}
		if (typeof version !== "string" || !versionAtLeast(version, MOD_KNOWS_ABSO)) return OLD_STATE_DIR;
	}
	return STATE_DIR;
}

/** A file under the user's home to read: ~/.abso/<parts>, else the old ~/.avcs/<parts> when only that exists, else the new place. */
export function homeFile(home: string, ...parts: string[]): string {
	for (const name of STATE_DIRS) {
		const path = join(home, name, ...parts);
		if (existsSync(path)) return path;
	}
	return join(home, STATE_DIR, ...parts);
}

/** Where to write a file under the user's home: always the new place. The old file is left as it is, for older clients and mods. */
export function homeWritePath(home: string, ...parts: string[]): string {
	return join(home, STATE_DIR, ...parts);
}
