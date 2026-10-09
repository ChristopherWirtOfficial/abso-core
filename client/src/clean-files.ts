// Which files `abso status` found the same as their known copy last time, so the
// next status reads only the files that may have changed, as git's index does.
//
// An entry is kept per file: the size, modified time and inode of the file on
// disk and of its known copy, each taken before either was read, and whether
// the file held a CR. It's trusted only while both still match, and only when
// both were changed clearly before the entry was made: a file changed in the
// same moment can't be told apart from one changed just after, so it's read.
// Anything abso writes into the folder or the known copy changes one side's
// size, time or inode, so no writer has to remember to drop entries.
//
// Only status and the checks it prints use this. record reads every file: a
// line status misses is a nuisance, a change record misses is lost work.

import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientVersion } from "./client-version.ts";
import { stateDir } from "./state-dir.ts";

const FILE = "clean.json";
const FORMAT = 1;
/** How much older than an entry a file's time must be to trust it. */
const RACY_MS = 2_000;

/** A file's place in the record now, taken before it is read. */
export interface CleanKey {
	readonly id: string;
	/** The newer of the two modified times. */
	readonly newest: number;
	/** The file on disk's mode bits. */
	readonly mode: number;
}

interface Entry {
	readonly id: string;
	readonly at: number;
	readonly cr: boolean;
}

export class CleanFiles {
	readonly #root: string;
	readonly #entries: Map<string, Entry>;
	/** When this run started looking; entries made in it carry this time. */
	readonly #at = Date.now();
	readonly #keys = new Map<string, CleanKey | undefined>();
	#changed = false;

	private constructor(root: string, entries: Map<string, Entry>) {
		this.#root = root;
		this.#entries = entries;
	}

	/** The folder's record, or an empty one when it's missing, unreadable, or from another format or client. */
	static load(root: string): CleanFiles {
		const entries = new Map<string, Entry>();
		try {
			const file = JSON.parse(readFileSync(join(stateDir(root), FILE), "utf8")) as {
				format?: unknown;
				client?: unknown;
				files?: Record<string, [string, number, boolean]>;
			};
			if (file.format === FORMAT && file.client === clientVersion() && typeof file.files === "object" && file.files)
				for (const [rel, [id, at, cr]] of Object.entries(file.files))
					if (typeof id === "string" && typeof at === "number" && typeof cr === "boolean")
						entries.set(rel, { id, at, cr });
		} catch {}
		return new CleanFiles(root, entries);
	}

	/**
	 * The key of a plain file on disk and its known copy; undefined for a link, or when either is missing.
	 * Taken once per run: a key taken before a later read is still safe to mark with, since any change
	 * after it was taken makes the next run's key differ.
	 */
	key(diskPath: string, knownPath: string): CleanKey | undefined {
		if (this.#keys.has(diskPath)) return this.#keys.get(diskPath);
		let key: CleanKey | undefined;
		try {
			const disk = lstatSync(diskPath);
			if (disk.isFile()) {
				const known = statSync(knownPath);
				key = {
					id: `${disk.size}:${disk.mtimeMs}:${disk.ino}|${known.size}:${known.mtimeMs}:${known.ino}`,
					newest: Math.max(disk.mtimeMs, known.mtimeMs),
					mode: disk.mode,
				};
			}
		} catch {}
		this.#keys.set(diskPath, key);
		return key;
	}

	/** Whether the file was the same as its known copy at this key, and if so whether it held a CR; undefined: read it. */
	check(rel: string, key: CleanKey): { cr: boolean } | undefined {
		const entry = this.#entries.get(rel);
		if (entry === undefined || entry.id !== key.id || key.newest >= entry.at - RACY_MS) return undefined;
		return { cr: entry.cr };
	}

	/** The file, read after `key` was taken, is the same as its known copy. */
	mark(rel: string, key: CleanKey, cr: boolean): void {
		const entry = this.#entries.get(rel);
		if (key.newest >= this.#at - RACY_MS) {
			// Too new to trust next time either; an old entry for it is no use now.
			if (entry !== undefined) {
				this.#entries.delete(rel);
				this.#changed = true;
			}
			return;
		}
		if (entry?.id === key.id && entry.cr === cr) return;
		this.#entries.set(rel, { id: key.id, at: this.#at, cr });
		this.#changed = true;
	}

	/** The file differs from its known copy, or is gone. */
	drop(rel: string): void {
		if (this.#entries.delete(rel)) this.#changed = true;
	}

	/** Write the record, if anything changed. Best effort: a run that can't write it just reads more next time. */
	save(): void {
		if (!this.#changed) return;
		try {
			const dir = stateDir(this.#root);
			mkdirSync(dir, { recursive: true });
			const files = Object.fromEntries([...this.#entries].map(([rel, e]) => [rel, [e.id, e.at, e.cr]]));
			const next = join(dir, `${FILE}.${process.pid}.tmp`);
			writeFileSync(next, JSON.stringify({ format: FORMAT, client: clientVersion(), files }));
			renameSync(next, join(dir, FILE));
			this.#changed = false;
		} catch {}
	}
}
