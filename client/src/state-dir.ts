// Where abso keeps its state (the rename from avcs). A new folder keeps it in .abso/ and the user's in ~/.abso/.
// Folders and machines from before keep working on .avcs/ and ~/.avcs/, untouched: a folder is never half-moved,
// so an older client or installed mod still finds it. A later `abso migrate` moves a folder once its mods are updated.
// No imports from the rest of the client, so any module can use this.

import { existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = ".abso";
export const OLD_STATE_DIR = ".avcs";
const STATE_DIRS = [STATE_DIR, OLD_STATE_DIR] as const;

/** A folder's state folder: whichever has a config.json (.abso first), else whichever exists, else .abso for a folder not made yet. */
export function stateDir(root: string): string {
	for (const name of STATE_DIRS) if (existsSync(join(root, name, "config.json"))) return join(root, name);
	for (const name of STATE_DIRS) if (existsSync(join(root, name))) return join(root, name);
	return join(root, STATE_DIR);
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
