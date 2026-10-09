// The agent's folder: which files count, reading them as text, and the
// known copy.
//
// The known copy (.avcs/known/<path>) is each file as the server's view of
// this agent has it, as far as the client knows. `record` sends the files
// that differ from it, the hook checks an edit against it before sending the
// edit, and `sync` only overwrites files that still match it.
//
// Skipped everywhere: .git, .avcs, .claude and node_modules, plus what git's
// ignore rules leave out: every .gitignore and .avcsignore in the folder,
// .git/info/exclude and git's global excludes file (core.ts has the rules).

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { blobOf, keptWholeAs, readKnownBlobs } from "./blobs.ts";
import { AVCS_DIR } from "./config.ts";
import { type GitHome, gitIgnoreSetup, type Ignore, isLocalOnly, makeIgnore, normalize, readAllSync } from "./core.ts";
import { type Mode, modeChange, onDisk, PLAIN, readKnownModes } from "./modes.ts";

export { type Ignore, isLocalOnly, normalize, withEndingsOf } from "./core.ts";
/** Files bigger than this are not sent as text. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const KNOWN = "known";

export function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

export function absolute(root: string, rel: string): string {
	return join(root, ...insideParts(rel));
}

/**
 * A folder-relative path's parts, refusing any that would leave the folder
 * (.., an absolute path, a drive). Answers from the server are screened
 * before this (safety.ts); this is the last line, so a path that slipped
 * through throws instead of being written.
 */
function insideParts(rel: string): string[] {
	const parts = rel.split("/");
	const bad =
		rel === "" ||
		rel.startsWith("/") ||
		/^[A-Za-z]:/.test(rel) ||
		parts.some((p) => p === ".." || p === "." || p === "" || (sep === "\\" && p.includes("\\")));
	if (bad) throw new Error(`refusing a path that would leave the folder: ${JSON.stringify(rel)}`);
	return parts;
}

/** The folder-relative path of an absolute path, or undefined when it is outside the folder. */
export function relativeTo(root: string, path: string): string | undefined {
	const rel = relative(root, path);
	if (rel === "" || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel) || rel.startsWith(sep)) return undefined;
	return toPosix(rel);
}

// --- ignore rules ---

/** Where git looks for its global files, from the environment. */
export function gitHome(env: Readonly<Record<string, string | undefined>> = process.env): GitHome {
	return { home: env.HOME || homedir(), ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}) };
}

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The folder's ignore rules. Ignore files are read when a question first reaches their folder. */
export function loadIgnore(root: string, where: GitHome = gitHome()): Ignore {
	const git = readAllSync(gitIgnoreSetup(root, where), readOrUndefined);
	return makeIgnore((rel) => readOrUndefined(absolute(root, rel)), git);
}

// --- walking and reading ---

/** Every file in the folder that the ignore rules keep, as sorted folder-relative paths. */
export function walk(root: string, ignore: Ignore = loadIgnore(root)): string[] {
	const out: string[] = [];
	const visit = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!ignore(rel, true)) visit(join(dir, entry.name), rel);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				// A link is a file of its own (its target is its mode); it is never followed.
				if (!ignore(rel, false)) out.push(rel);
			}
		}
	};
	visit(root, "");
	return out.sort();
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The bytes as text, or undefined when they are binary (a NUL byte or invalid UTF-8) or too big. */
export function asText(bytes: Uint8Array): string | undefined {
	if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return undefined;
	try {
		return DECODER.decode(bytes);
	} catch {
		return undefined;
	}
}

/** A file's text, undefined when missing or not text. */
export function readText(path: string): string | undefined {
	try {
		return asText(readFileSync(path));
	} catch {
		return undefined;
	}
}

/**
 * A file the client doesn't send: over the server's limit for one file
 * (MAX_BLOB_BYTES). `kept` is set when the server still has the file's last
 * version, which stays.
 */
export interface LeftOut {
	readonly path: string;
	readonly reason: "too big";
	readonly kept?: boolean;
}

/**
 * A file the server has as text that now reads as binary: almost always an
 * accident (a stray NUL byte), so it is not sent until it is fixed or
 * `--binary` says it is meant. `offset` and `line` say where the first bad
 * byte is.
 */
export interface TurnedBinary {
	readonly path: string;
	readonly why: "a NUL byte" | "bytes that are not UTF-8";
	readonly offset: number;
	readonly line: number;
}

/** Where a would-be text file first stops being text. */
export function firstBadByte(bytes: Uint8Array): { why: TurnedBinary["why"]; offset: number; line: number } {
	let offset = bytes.indexOf(0);
	let why: TurnedBinary["why"] = "a NUL byte";
	// Before any NUL, look for the first byte that breaks UTF-8.
	const end = offset < 0 ? bytes.length : offset;
	for (let i = 0; i < end; ) {
		const b = bytes[i]!;
		const need = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1;
		let ok = need >= 0 && i + need < bytes.length;
		for (let k = 1; ok && k <= need; k++) ok = (bytes[i + k]! & 0xc0) === 0x80;
		if (!ok) {
			offset = i;
			why = "bytes that are not UTF-8";
			break;
		}
		i += need + 1;
	}
	if (offset < 0) offset = 0;
	let line = 1;
	for (let i = 0; i < offset; i++) if (bytes[i] === 0x0a) line++;
	return { why, offset, line };
}

/** A binary file (or text too big to diff) to send as a blob: its hash and bytes. */
export interface BlobToSend {
	readonly sha: string;
	readonly bytes: Uint8Array;
}

/**
 * Every file in the folder, in the server's form: text files (empty ones too)
 * as text, binary files and text over MAX_TEXT_BYTES as blobs, the modes that
 * aren't plain, and the files over the server's limit, left out.
 */
export function readFolder(
	root: string,
	ignore: Ignore = loadIgnore(root),
): { files: Map<string, string>; blobs: Map<string, BlobToSend>; modes: Record<string, Mode>; leftOut: LeftOut[] } {
	const files = new Map<string, string>();
	const blobs = new Map<string, BlobToSend>();
	const modes: Record<string, Mode> = {};
	const leftOut: LeftOut[] = [];
	for (const rel of walk(root, ignore)) {
		const d = onDisk(absolute(root, rel));
		if (d === undefined) continue;
		if (d.text === undefined) {
			const b = blobOf(absolute(root, rel));
			if (b === undefined) continue;
			if ("tooBig" in b) {
				leftOut.push({ path: rel, reason: "too big" });
				continue;
			}
			blobs.set(rel, { sha: b.sha, bytes: b.bytes });
		} else {
			files.set(rel, normalize(d.text));
		}
		const change = modeChange(PLAIN, d);
		if (change) modes[rel] = change;
	}
	return { files, blobs, modes, leftOut };
}

/** Waits between rename tries, about a second in all: Windows refuses a rename while an editor, a scanner or an indexer holds the file. */
const RENAME_WAITS_MS = [10, 30, 100, 250, 600];
/** The errors a held file gives on Windows; anything else fails at once. */
const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Write a file by way of a temporary file and a rename, so a reader sees the
 * old file or the new one, never half (#51, as git writes its index). A held
 * file is tried again for about a second; then it throws, rather than write
 * in place, where a crash would leave half a file.
 */
export function writeFileAtomic(
	path: string,
	text: string | Uint8Array,
	rename: (from: string, to: string) => void = renameSync,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	for (let attempt = 0; ; attempt++) {
		try {
			rename(tmp, path);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			const wait = RENAME_WAITS_MS[attempt];
			if (!HELD.has(code) || wait === undefined) {
				rmSync(tmp, { force: true });
				throw Object.assign(
					new Error(
						`couldn't replace ${path} (${code || (err as Error).message}${HELD.has(code) ? ", still held by another program after a second" : ""})`,
					),
					{ code },
				);
			}
			// A short synchronous wait: callers write file by file, in order.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
		}
	}
}

export function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

// --- pausing ---

/** .avcs/paused: while it exists, nothing from the folder is sent (abso pause, abso resume). */
export function pausedPath(root: string): string {
	return join(root, AVCS_DIR, "paused");
}

export function isPaused(root: string): boolean {
	return existsSync(pausedPath(root));
}

// --- the known copy ---

function knownPath(root: string, rel: string): string {
	return join(root, AVCS_DIR, KNOWN, ...insideParts(rel));
}

export function readKnown(root: string, rel: string): string | undefined {
	return readText(knownPath(root, rel));
}

export function writeKnown(root: string, rel: string, text: string): void {
	writeFileAtomic(knownPath(root, rel), text);
}

/** Forget a file, so the next `record` sends it whole. */
export function forgetKnown(root: string, rel: string): void {
	removeFile(knownPath(root, rel));
}

/** Every path in the known copy. */
export function listKnown(root: string): string[] {
	const base = join(root, AVCS_DIR, KNOWN);
	if (!existsSync(base)) return [];
	const out: string[] = [];
	const visit = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) visit(join(dir, entry.name), rel);
			else if (entry.isFile() && !entry.name.endsWith(".tmp")) out.push(rel);
		}
	};
	visit(base, "");
	return out.sort();
}

export function clearKnown(root: string): void {
	rmSync(join(root, AVCS_DIR, KNOWN), { recursive: true, force: true });
}

/**
 * What `record` would send: files that differ from the known copy (in the
 * server's form), known files that are gone (null), and the modes that differ
 * from the known modes. An empty file is a file like any other (""); a link's
 * text is "".
 */
export function unrecorded(
	root: string,
	all = false,
	meantBinary: ReadonlySet<string> = new Set(),
): {
	files: Map<string, string | null>;
	blobs: Map<string, BlobToSend>;
	modes: Record<string, Mode>;
	leftOut: LeftOut[];
	turnedBinary: TurnedBinary[];
} {
	const ignore = loadIgnore(root);
	const out = new Map<string, string | null>();
	const blobs = new Map<string, BlobToSend>();
	const modes: Record<string, Mode> = {};
	const present = new Set<string>();
	const leftOut: LeftOut[] = [];
	const turnedBinary: TurnedBinary[] = [];
	// Exact names: on a case-insensitive disk, known/a.ts would also answer for A.ts, hiding a rename that changes only case.
	const knownPaths = new Set(listKnown(root));
	const knownBlobs = readKnownBlobs(root);
	const knownModes = readKnownModes(root);
	for (const rel of walk(root, ignore)) {
		const was = knownModes.get(rel) ?? PLAIN;
		const d = onDisk(absolute(root, rel), was);
		if (d === undefined) continue;
		if (d.text === undefined) {
			const b = blobOf(absolute(root, rel));
			if (b === undefined) continue;
			if ("tooBig" in b) {
				// Over the server's limit: what the server has stays, nothing is deleted.
				const kept = knownPaths.has(rel) || knownBlobs.has(rel);
				if (kept) present.add(rel);
				leftOut.push({ path: rel, reason: "too big", ...(kept ? { kept } : {}) });
				continue;
			}
			present.add(rel);
			if (knownPaths.has(rel) && b.size <= MAX_TEXT_BYTES && !meantBinary.has(rel)) {
				// Was text, now binary: hold it back (the server keeps its text) and say where.
				turnedBinary.push({ path: rel, ...firstBadByte(b.bytes) });
				continue;
			}
			if (all || knownBlobs.get(rel) !== b.sha) blobs.set(rel, { sha: b.sha, bytes: b.bytes });
		} else {
			const text = normalize(d.text);
			const known = knownPaths.has(rel) ? readKnown(root, rel) : undefined;
			present.add(rel);
			// A file the server keeps whole has no known copy, only its hash (#46).
			if (all || (known !== text && !(known === undefined && keptWholeAs(text, knownBlobs.get(rel)))))
				out.set(rel, text);
		}
		// --all sends every file's whole mode, as it sends every file's text.
		const change = all ? { exec: d.exec, link: d.link } : modeChange(was, d);
		if (change) modes[rel] = change;
	}
	for (const rel of new Set([...knownPaths, ...knownBlobs.keys()])) {
		// A local-only file the server still has (recorded before the client skipped
		// it) is sent once as deleted, so it leaves the draft; the file on disk stays.
		if (isLocalOnly(rel) || (!present.has(rel) && !ignore(rel, false))) out.set(rel, null);
	}
	return { files: out, blobs, modes, leftOut, turnedBinary };
}

/** Keep the news the agent was given in .avcs/news.log, one dated line each, for anything that shows it later. */
export function logNews(root: string, news: readonly string[]): void {
	if (news.length === 0) return;
	const at = new Date().toISOString();
	try {
		appendFileSync(join(root, AVCS_DIR, "news.log"), news.map((n) => `${at}\t${n}\n`).join(""));
	} catch {
		// Best effort.
	}
}

export function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// --- line endings for new files ---

/**
 * The line endings git would give each of these files if it wrote them new
 * into the folder: from .gitattributes (text, eol) and git's config
 * (core.autocrlf, core.eol), asked of git itself so its rules hold exactly.
 * LF outside a git repository, or when git can't be run. A file already on
 * disk keeps its own endings instead (withEndingsOf).
 */
export function newFileEndings(root: string, rels: readonly string[]): Map<string, "crlf" | "lf"> {
	const out = new Map<string, "crlf" | "lf">(rels.map((r) => [r, "lf"]));
	if (rels.length === 0 || !existsSync(join(root, ".git"))) return out;
	const git = (args: string[], input?: string): string | undefined => {
		try {
			return execFileSync("git", ["-C", root, ...args], {
				input,
				stdio: ["pipe", "pipe", "ignore"],
				maxBuffer: 64 << 20,
			}).toString();
		} catch {
			return undefined;
		}
	};
	const config = new Map<string, string>();
	for (const line of (git(["config", "--get-regexp", "^core.(autocrlf|eol)$"]) ?? "").split("\n")) {
		const [k, v] = line.trim().split(/\s+/);
		if (k && v) config.set(k.toLowerCase(), v.toLowerCase());
	}
	const autocrlf = config.get("core.autocrlf");
	const coreEol = config.get("core.eol") ?? "native";
	const attrs = git(["check-attr", "--stdin", "-z", "text", "eol"], rels.join("\0") + "\0");
	if (attrs === undefined) return out;
	const f = attrs.split("\0");
	const seen = new Map<string, { text?: string; eol?: string }>();
	for (let i = 0; i + 2 < f.length; i += 3) {
		const a = seen.get(f[i]!) ?? {};
		if (f[i + 1] === "text") a.text = f[i + 2];
		else a.eol = f[i + 2];
		seen.set(f[i]!, a);
	}
	for (const rel of rels) {
		const { text = "unspecified", eol = "unspecified" } = seen.get(rel) ?? {};
		// As git's checkout does: -text (or binary) is left alone; eol= decides; then core.autocrlf; then core.eol for text files.
		let crlf = false;
		if (text === "unset") crlf = false;
		else if (eol === "crlf" || eol === "lf") crlf = eol === "crlf";
		else if (autocrlf === "true") crlf = true;
		else if (autocrlf === "input") crlf = false;
		else if (text === "set" || text === "auto")
			crlf = coreEol === "crlf" || (coreEol === "native" && process.platform === "win32");
		out.set(rel, crlf ? "crlf" : "lf");
	}
	return out;
}
