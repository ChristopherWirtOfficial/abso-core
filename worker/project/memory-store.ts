import type { Entry, ProjectStore } from "./project-types.ts";

/** A store that keeps entries in memory, for tests and local runs. */
export class MemoryStore implements ProjectStore {
	readonly entries: Entry[] = [];
	append(entries: readonly Entry[]): void {
		// A round trip through JSON, so tests catch anything that wouldn't survive storage.
		for (const e of entries) this.entries.push(JSON.parse(JSON.stringify(e)) as Entry);
	}
}
