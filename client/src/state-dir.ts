// Where abso keeps its state (the rename from avcs). Reading takes .abso/ first, then .avcs/, so a folder in
// either works. A new folder is still made with .avcs/ for now: an edit mod or Cursor hook installed before the
// rename looks only for .avcs/config.json, and would stop recording a .abso/ folder's edits without a word.
// New folders move to .abso/ once installs can say which mods know it; `abso migrate` will move old ones. The
// user's files are written to ~/.abso/ (an older client that can't find them says so: it isn't silent).
// No imports from the rest of the client, so any module can use this.

import { existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = ".abso";
export const OLD_STATE_DIR = ".avcs";
const STATE_DIRS = [STATE_DIR, OLD_STATE_DIR] as const;

/** A folder's state folder: whichever has a config.json (.abso first), else whichever exists, else .avcs for a folder not made yet (see above). */
export function stateDir(root: string): string {
	for (const name of STATE_DIRS) if (existsSync(join(root, name, "config.json"))) return join(root, name);
	for (const name of STATE_DIRS) if (existsSync(join(root, name))) return join(root, name);
	return join(root, NEW_FOLDER_DIR);
}

/** What a new folder is made with: .avcs until installed mods can be relied on to know .abso. */
export const NEW_FOLDER_DIR: string = OLD_STATE_DIR;

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
