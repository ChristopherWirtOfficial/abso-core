// The executable bit and symbolic links (#27, contract 7d49f0a).
//
// The server holds each file's mode beside its text: whether it is
// executable, and whether it is a symbolic link (whose text is ""). The client
// keeps the modes it knows in .avcs/modes.json, as it keeps the known copy of
// the text, and sends only what changed.
//
// Windows has no executable bit, so there (like git's core.fileMode=false)
// the bit is never read from disk: a file keeps the bit the server has. A
// link is never followed. Where a link can't be made (Windows without the
// right to make links), the client writes a plain file holding the target,
// as git does with core.symlinks=false, and that file counts as the link.

import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readText, writeFileAtomic } from "./folder.ts";
import { stateDir } from "./state-dir.ts";

/** A change to a file's mode: only the fields given change. */
export interface Mode {
	readonly exec?: boolean;
	readonly link?: string | null;
}
export type Modes = Readonly<Record<string, Mode>>;

/** A file's whole mode. */
export interface FullMode {
	readonly exec: boolean;
	readonly link: string | null;
}

export const PLAIN: FullMode = { exec: false, link: null };

/** Whether this disk keeps the executable bit (git's core.fileMode). */
export const FILE_MODE = process.platform !== "win32";

const MODES_FILE = "modes.json";

function modesPath(root: string): string {
	return join(stateDir(root), MODES_FILE);
}

/** The modes the server has, as far as the client knows: only files that are executable or links. */
export function readKnownModes(root: string): Map<string, FullMode> {
	try {
		const raw = JSON.parse(readFileSync(modesPath(root), "utf8")) as Record<string, Partial<FullMode>>;
		return new Map(
			Object.entries(raw).map(([rel, m]) => [
				rel,
				{ exec: m.exec === true, link: typeof m.link === "string" ? m.link : null },
			]),
		);
	} catch {
		return new Map();
	}
}

export function writeKnownModes(root: string, modes: ReadonlyMap<string, FullMode>): void {
	const out: Record<string, Partial<FullMode>> = {};
	for (const [rel, m] of [...modes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (m.exec || m.link !== null)
			out[rel] = { ...(m.exec ? { exec: true } : {}), ...(m.link !== null ? { link: m.link } : {}) };
	}
	writeFileAtomic(modesPath(root), `${JSON.stringify(out, null, 1)}\n`);
}

/** Fold mode changes (only the fields given) into the known modes; a deleted file loses its entry. */
export function foldModes(known: Map<string, FullMode>, modes: Modes, deleted: Iterable<string> = []): void {
	for (const [rel, m] of Object.entries(modes)) {
		const was = known.get(rel) ?? PLAIN;
		known.set(rel, { exec: m.exec ?? was.exec, link: m.link === undefined ? was.link : m.link });
	}
	for (const rel of deleted) known.delete(rel);
}

/** What a path holds, judged as the server sees it; undefined when it is gone. `text` is undefined for a binary file. */
export interface OnDisk {
	readonly text: string | undefined;
	readonly exec: boolean;
	readonly link: string | null;
	/** A plain file standing in for a link that couldn't be made. */
	readonly standIn: boolean;
}

export function onDisk(path: string, known: FullMode = PLAIN): OnDisk | undefined {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return undefined;
	}
	if (st.isSymbolicLink())
		return { text: "", exec: known.exec, link: readlinkSync(path).replace(/\\/g, "/"), standIn: false };
	if (known.link !== null) {
		// A stand-in: the file holds the target; editing it changes the target, as in git.
		const raw = readText(path);
		if (raw !== undefined) return { text: "", exec: known.exec, link: raw.replace(/\r?\n$/, ""), standIn: true };
	}
	return { text: readText(path), exec: FILE_MODE ? (st.mode & 0o111) !== 0 : known.exec, link: null, standIn: false };
}

/** The fields of `now` that differ from `was`, or undefined when none do. */
export function modeChange(was: FullMode, now: FullMode): Mode | undefined {
	const out: { exec?: boolean; link?: string | null } = {};
	if (now.exec !== was.exec) out.exec = now.exec;
	if (now.link !== was.link) out.link = now.link;
	return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Put a file's mode on disk: make the link (or its stand-in), or set the
 * executable bit where the disk keeps it. The file's text is already written.
 */
export function applyMode(path: string, mode: FullMode): void {
	if (mode.link !== null) {
		try {
			unlinkSync(path);
		} catch {
			// Not there yet.
		}
		mkdirSync(dirname(path), { recursive: true });
		try {
			symlinkSync(mode.link, path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw err;
			writeFileSync(path, mode.link);
		}
		return;
	}
	if (!FILE_MODE) return;
	try {
		const bits = statSync(path).mode & 0o777;
		const want = mode.exec ? bits | ((bits & 0o444) >> 2) : bits & ~0o111;
		if (want !== bits) chmodSync(path, want);
	} catch {
		// Gone, or not ours to change.
	}
}
