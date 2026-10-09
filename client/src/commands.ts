// The abso commands other than `hook`: init, join, record, publish, sync, run
// and status. Each returns what to print and the exit code, so tests can call
// them directly.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The engine's own key, so both sides match spellings the same way (#49). Not in core.ts: the edit mod installs core.ts alone.
import {
	type Api,
	type Collision,
	type FileChange,
	type MergedLine,
	type News,
	newsLines,
	type SyncAnswer,
} from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { blobOf, keptWholeAs, MAX_BLOB_BYTES, readKnownBlobs, writeKnownBlobs } from "./blobs.ts";
import { type Env, EXIT, heard, type Output, open } from "./command-env.ts";
import { AVCS_DIR, findRoot, isReader } from "./config.ts";
import { spellingText, uncomposedText } from "./core.ts";
import { pairRenames } from "./diff.ts";
import type { BlobToSend, TurnedBinary } from "./folder.ts";
import {
	absolute,
	forgetKnown,
	isLocalOnly,
	isPaused,
	type LeftOut,
	listKnown,
	MAX_TEXT_BYTES,
	newFileEndings,
	normalize,
	pausedPath,
	readKnown,
	removeFile,
	unrecorded,
	withEndingsOf,
	writeFileAtomic,
	writeKnown,
} from "./folder.ts";
import { withFolderLock } from "./lock.ts";
import type { OnDisk } from "./modes.ts";
import { applyMode, type FullMode, foldModes, onDisk, PLAIN, readKnownModes, writeKnownModes } from "./modes.ts";
import { type Refused, screenAnswer, unsafePath } from "./safety.ts";

export {
	knownPrep,
	parallelScript,
	type RunStamp,
	runBisect,
	runCommand,
	runLogs,
	runPrep,
	runRun,
	shellWord,
	undoGitBashPaths,
	withEntries,
} from "./box-commands.ts";
export { collisionsHeading, collisionText, mergedLinesText } from "./collision-text.ts";
export { type Env, EXIT, newsText, type Output, open, plural, takeNews } from "./command-env.ts";
export { runInit, runJoin } from "./join-commands.ts";
export { runPublish, runSync, sameVersionHint } from "./publish-commands.ts";
export { imageTokens, runFetch, runServe, runShot } from "./serve-commands.ts";
export {
	crlfOnly,
	missingHere,
	missingText,
	openCollisionsText,
	runFixEol,
	runMv,
	runReader,
	runSettle,
	runStatus,
	staleModText,
} from "./status-commands.ts";

// --- record ---

interface Recorded {
	readonly sent: number;
	/** The paths sent. */
	readonly paths: readonly string[];
	/** Those of them sent as deleted (gone from the folder). */
	readonly deleted: readonly string[];
	/** Those of them new to avcs: no copy recorded before (#37, Builder 7: a file a script made is easy to miss). */
	readonly added?: readonly string[];
	/** Nothing was sent because the folder is paused (abso pause). */
	readonly paused?: boolean;
	readonly changed: readonly string[] | number | undefined;
	readonly news: News;
	readonly leftOut: readonly LeftOut[];
	readonly turnedBinary: readonly TurnedBinary[];
}

/** The warning for text files that turned binary: what, where, and what to do. Empty when there are none. */
export function turnedBinaryText(list: readonly TurnedBinary[]): string[] {
	return list.map(
		(t) =>
			`NOT SENT: ${t.path} was text and now has ${t.why} at line ${t.line} (byte ${t.offset}). The server keeps its last text, so the other agents still have the old file. Fix the file; or, if it is meant to be binary now, pass --binary ${t.path}.`,
	);
}

/** The paths given with --binary (comma-separated, relative to the folder). */
export function meantBinary(args: Parsed): Set<string> {
	return new Set(
		(str(args, "binary") ?? "")
			.split(",")
			.map((p) => p.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
			.filter((p) => p !== ""),
	);
}

/** One line naming the files left out, or none. */
export function leftOutText(leftOut: readonly LeftOut[]): string[] {
	if (leftOut.length === 0) return [];
	const why = (f: LeftOut) => `${f.path}${f.kept ? " (the server keeps its last version)" : ""}`;
	return [
		`Left out, over the server's ${MAX_BLOB_BYTES / 1024 / 1024} MB limit for one file: ${leftOut.map(why).join(", ")}.`,
	];
}

/**
 * A command that left files out for size did not do everything it was asked: say so in the exit code too, so
 * a script, CI or an agent cannot read "ok" while a file is missing. Other exits (refused, queued) stay as they are.
 */
export function withLeftOut(out: Output, leftOut: readonly LeftOut[]): Output {
	if (leftOut.length === 0) return out;
	const text = out.text.includes("Left out,") ? out.text : [out.text, ...leftOutText(leftOut)].join("\n");
	return {
		...out,
		text: `${text}\nExit ${EXIT.error}: ${leftOut.length} file${leftOut.length === 1 ? " was" : "s were"} not sent.`,
		json: { ...out.json, leftOut },
		exit: out.exit === undefined || out.exit === EXIT.ok ? EXIT.error : out.exit,
	};
}

/** Upload binary files' bytes before the record or init that names them, each hash once. */
export async function uploadBlobs(api: Api, blobs: ReadonlyMap<string, BlobToSend>): Promise<void> {
	const seen = new Set<string>();
	for (const b of blobs.values()) {
		if (seen.has(b.sha)) continue;
		seen.add(b.sha);
		await api.putBlob(b.sha, b.bytes);
	}
}

/**
 * Whether the file at `rel` is as the server last gave it (or gone), so a sync
 * may replace it: text compared with the known copy, a binary file by hash.
 */
function untouchedOnDisk(
	root: string,
	rel: string,
	now: OnDisk | undefined,
	knownBlobs: ReadonlyMap<string, string>,
): boolean {
	if (now === undefined) return true;
	if (now.text !== undefined) {
		const known = readKnown(root, rel);
		// A file the server keeps whole (#46) is known by its hash.
		return known !== undefined ? normalize(now.text) === known : keptWholeAs(normalize(now.text), knownBlobs.get(rel));
	}
	const blob = knownBlobs.get(rel);
	const b = blobOf(absolute(root, rel));
	return blob !== undefined && b !== undefined && "sha" in b && b.sha === blob;
}

/** Send what differs from the known copy. Used by record, publish and sync. */
/** Record the folder, holding its lock (#51): known copies, modes and blobs are rewritten. */
export async function recordFolder(
	root: string,
	api: Api,
	all = false,
	binary: ReadonlySet<string> = new Set(),
): Promise<Recorded> {
	return withFolderLock(root, "record", () => recordFolderLocked(root, api, all, binary));
}

async function recordFolderLocked(
	root: string,
	api: Api,
	all: boolean,
	binary: ReadonlySet<string>,
): Promise<Recorded> {
	if (isPaused(root))
		return {
			sent: 0,
			paths: [],
			deleted: [],
			paused: true,
			changed: [],
			news: undefined,
			leftOut: [],
			turnedBinary: [],
		};
	// A reader records nothing (#37); the server would refuse it anyway.
	if (isReader(root))
		return { sent: 0, paths: [], deleted: [], changed: [], news: undefined, leftOut: [], turnedBinary: [] };
	const { files, blobs, modes, leftOut, turnedBinary } = unrecorded(root, all, binary);
	const paths = [...new Set([...files.keys(), ...blobs.keys(), ...Object.keys(modes)])].sort();
	const knownBefore = new Set([...listKnown(root), ...readKnownBlobs(root).keys()]);
	const added = paths.filter((p) => files.get(p) !== null && !knownBefore.has(p));
	const sent = paths.length;
	const deleted = [...files]
		.filter(([, text]) => text === null)
		.map(([rel]) => rel)
		.sort();
	if (sent === 0) return { sent: 0, paths, deleted, changed: [], news: undefined, leftOut, turnedBinary };
	await uploadBlobs(api, blobs);
	const answer = await api.record(
		Object.fromEntries(files),
		{},
		modes,
		Object.fromEntries([...blobs].map(([rel, b]) => [rel, b.sha])),
	);
	if (!answer.ok) throw new Error(`the server refused the record: ${answer.reason ?? "no reason given"}`);
	// Forget before writing: after a rename that changes only case, known/a.ts and known/A.ts are one file on Windows and macOS.
	for (const [rel, text] of files) if (text === null) forgetKnown(root, rel);
	for (const [rel, text] of files) if (text !== null) writeKnown(root, rel, text);
	const knownBlobs = readKnownBlobs(root);
	if (blobs.size > 0 || [...files.keys()].some((rel) => knownBlobs.has(rel))) {
		for (const rel of files.keys()) knownBlobs.delete(rel);
		for (const [rel, b] of blobs) {
			forgetKnown(root, rel);
			knownBlobs.set(rel, b.sha);
		}
		writeKnownBlobs(root, knownBlobs);
	}
	const gone = [...files].filter(([, text]) => text === null).map(([rel]) => rel);
	const knownModes = readKnownModes(root);
	if (Object.keys(modes).length > 0 || gone.some((rel) => knownModes.has(rel))) {
		foldModes(knownModes, modes, gone);
		writeKnownModes(root, knownModes);
	}
	// Another spelling of an existing file went in as that file (#49); a new name not in composed form gets a gentle word.
	heard(root, [
		...newsLines(answer.news),
		...(answer.spelling ?? []).map(spellingText),
		...(answer.uncomposed ?? []).map(uncomposedText),
	]);
	return { sent, paths, deleted, added, changed: answer.changed, news: answer.news, leftOut, turnedBinary };
}

/** "Recorded 3 files first: a, b, c." (names cut short past 8), or a word that the folder is paused. Empty when nothing was sent. */
export function recordedFirst(r: Recorded): string[] {
	if (r.paused) return ["Recording is paused (abso resume): your folder's changes were not sent first."];
	if (r.sent === 0) return [];
	return [`Recorded first: ${recordedList(r)}.`];
}

/** "2 changed (a, b), 3 deleted (x, y, z)": deletions said as such (#37, Builder 2 read its rm'd files as edits). */
function recordedList(r: Recorded): string {
	const names = (list: readonly string[]) =>
		list.length <= LISTED ? list.join(", ") : `${list.slice(0, LISTED).join(", ")}, and ${list.length - LISTED} more`;
	const gone = new Set(r.deleted);
	const fresh = new Set(r.added ?? []);
	const changed = r.paths.filter((p) => !gone.has(p) && !fresh.has(p));
	// New files are named in full: they are the ones a script made and nobody remembers (#37, Builder 7).
	return [
		...(fresh.size > 0 ? [`${fresh.size} new (${[...fresh].join(", ")})`] : []),
		...(changed.length > 0 ? [`${changed.length} changed (${names(changed)})`] : []),
		...(r.deleted.length > 0 ? [`${r.deleted.length} deleted (${names(r.deleted)})`] : []),
	].join(", ");
}

export const READER_REFUSES =
	"this folder is a reader: it records and publishes nothing (abso reader off makes it a writer again)";

/** abso pause: send nothing from the folder (no hook, no record) until abso resume. */
export async function runPause(_args: Parsed, env: Env): Promise<Output> {
	const { root } = open(env);
	const was = isPaused(root);
	writeFileSync(pausedPath(root), `${new Date().toISOString()}\n`);
	return {
		text: `${was ? "Recording was already paused." : "Recording is paused."} The edit hook sends nothing, abso record refuses, and other commands skip recording first. abso run still sends the folder as it is to the box. abso resume ends it.`,
		json: { paused: true },
	};
}

export async function runResume(_args: Parsed, env: Env): Promise<Output> {
	const { root } = open(env);
	const was = isPaused(root);
	rmSync(pausedPath(root), { force: true });
	return {
		text: was
			? "Recording again. Changes made while paused go at the next abso record (or publish, sync, ...); abso status lists them."
			: "Recording was not paused.",
		json: { paused: false },
	};
}

export async function runRecord(args: Parsed, env: Env): Promise<Output> {
	if (isReader(findRoot(env.cwd) ?? env.cwd)) throw new UsageError(READER_REFUSES);
	const { root, api } = open(env);
	if (isPaused(root))
		return {
			exit: EXIT.refused,
			text: "Not recorded: recording is paused. abso resume, then abso record.",
			json: { paused: true },
		};
	const r = await recordFolder(root, api, bool(args, "all"), meantBinary(args));
	const changed = Array.isArray(r.changed) ? r.changed.length : r.changed;
	const text =
		r.sent === 0
			? "Nothing to record: the folder matches what the server has."
			: `Recorded ${recordedList(r)}${changed === undefined ? "" : `; ${changed} changed on the server`}.`;
	return withLeftOut(
		{
			text: [...turnedBinaryText(r.turnedBinary), text, ...leftOutText(r.leftOut)].join("\n"),
			json: {
				sent: r.sent,
				changed: r.changed ?? null,
				news: newsLines(r.news),
				leftOut: r.leftOut,
				turnedBinary: r.turnedBinary,
			},
		},
		r.leftOut,
	);
}

// --- writing answers into the folder ---

/**
 * Bring the folder to shared and set the agent's base. Writes only files that
 * still match the known copy (or are new), so unrecorded work is never
 * overwritten.
 */
export async function syncFolder(root: string, api: Api, full = false): Promise<Applied> {
	return applyAnswer(root, api, await api.sync({ full }));
}

/** What writing a sync or switch answer into the folder did. */
export interface Applied {
	readonly version: number;
	readonly written: string[];
	readonly deleted: string[];
	readonly kept: string[];
	readonly dropped: string[];
	readonly collisions: readonly Collision[];
	/** Text files the answer deleted and wrote again under a new path, paired as git pairs renames. Each is in `written` and `deleted` too. */
	readonly renamed: readonly { readonly from: string; readonly to: string }[];
	/** Paths in the answer that were not touched: outside the folder, into .git/.claude/.avcs, a device, or through a link (safety.ts). */
	readonly refused: readonly Refused[];
	/** Lines both sides changed that the server merged item by item. */
	readonly merged: readonly MergedLine[];
	/** Files a sync couldn't write here, this one or an earlier one, still stale (#51): path -> when and why. */
	readonly unwritten: Readonly<Record<string, Unwritten>>;
}

/** How many names a summary line shows before "and N more". */
export const LISTED = 8;
/** How far back an empty publish looks for this agent's last publish. */
export const FOLDER_LOG_LIMIT = 200;

/**
 * The files a sync or switch changed. A line per kind, with the names cut
 * short past LISTED (a big sync used to print a line per file); --verbose
 * gives a line per file.
 */
export function changedFilesText(
	command: string,
	written: readonly string[],
	deleted: readonly string[],
	renamed: readonly { readonly from: string; readonly to: string }[],
	verbose: boolean,
): string[] {
	const moves = renamed.map((r) => `${r.from} -> ${r.to}`);
	if (verbose)
		return [
			...written.map((f) => `  updated ${f}`),
			...deleted.map((f) => `  deleted ${f}`),
			...moves.map((m) => `  renamed ${m}`),
		];
	const some = (names: readonly string[]) =>
		names.length <= LISTED
			? names.join(", ")
			: `${names.slice(0, LISTED).join(", ")}, and ${names.length - LISTED} more`;
	return [
		...(written.length > 0 ? [`  updated: ${some(written)}`] : []),
		...(deleted.length > 0 ? [`  deleted: ${some(deleted)}`] : []),
		...(moves.length > 0 ? [`  renamed: ${some(moves)}`] : []),
		...([written, deleted, moves].some((l) => l.length > LISTED)
			? [`  (abso ${command} --verbose lists every file)`]
			: []),
	];
}

/** A file a sync couldn't write (#51): the server takes the folder to have `version`'s text, so no later sync sends it again. */
export interface Unwritten {
	readonly version: number;
	readonly why: string;
}

const UNWRITTEN_FILE = "unwritten.json";

/** Files earlier syncs couldn't write here, kept in .avcs/unwritten.json until a write of them works. */
export function readUnwritten(root: string): Record<string, Unwritten> {
	try {
		return JSON.parse(readFileSync(join(root, AVCS_DIR, UNWRITTEN_FILE), "utf8")) as Record<string, Unwritten>;
	} catch {
		return {};
	}
}

/** Status's line for them, and sync's for ones an earlier sync named. */
export function unwrittenText(
	unwritten: Readonly<Record<string, Unwritten>>,
	skip: ReadonlySet<string> = new Set(),
): string[] {
	const paths = Object.keys(unwritten)
		.filter((p) => !skip.has(p))
		.sort();
	if (paths.length === 0) return [];
	const list = paths.map((p) => `${p} (version ${unwritten[p]!.version}: ${unwritten[p]!.why})`).join(", ");
	return [
		`Stale here: a sync couldn't write ${paths.length === 1 ? "this file" : "these files"}, and no later sync sends ${paths.length === 1 ? "it" : "them"} again. Close whatever holds ${paths.length === 1 ? "it" : "them"}, then abso sync --full: ${list}`,
	];
}

/** Write the files a sync or switch answer lists into the folder (the same rules as sync). */
/** Write a sync's answer into the folder, holding its lock (#51). */
export async function applyAnswer(root: string, api: Api, unscreened: SyncAnswer): Promise<Applied> {
	return withFolderLock(root, "sync", () => applyAnswerLocked(root, api, unscreened));
}

async function applyAnswerLocked(root: string, api: Api, unscreened: SyncAnswer): Promise<Applied> {
	// Other agents' paths: nothing outside this folder, in .git/.claude/.avcs, or through a link.
	const { answer, refused } = screenAnswer(root, unscreened);
	// A write the disk refuses anyway is named and skipped, so the rest of the sync still lands with its
	// known copies and modes, rather than stopping partway (AVCS - Git Lessons; git checks every path first).
	const failed = new Set<string>();
	// Remembered until a write works (#51): the server won't send these files again.
	const unwritten = readUnwritten(root);
	const unwrittenBefore = JSON.stringify(unwritten);
	const tryWrite = (rel: string, write: () => void): boolean => {
		try {
			write();
			delete unwritten[rel];
			return true;
		} catch (e) {
			failed.add(rel);
			const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
			refused.push({ path: rel, why: `writing it here failed (${code})` });
			unwritten[rel] = { version: answer.version, why: code };
			return false;
		}
	};
	const written: string[] = [];
	const deleted: string[] = [];
	const kept: string[] = [];
	// Text that left one path and arrived at a new one, to tell renames from a delete and an add.
	const gone: FileChange[] = [];
	const arrived: FileChange[] = [];
	// Local-only files (.claude/, ...) the server still holds: never written here,
	// and sent back as deleted so they leave this agent's view and draft.
	const dropped = new Set<string>();
	const knownModes = readKnownModes(root);
	const knownBlobs = readKnownBlobs(root);
	const blobsBefore = JSON.stringify([...knownBlobs]);
	for (const c of answer.collisions ?? [])
		if (isLocalOnly(c.file) && unsafePath(c.file) === undefined) dropped.add(c.file);
	// Deletions first: on a case-insensitive disk a rename from a.ts to A.ts is one file, and
	// writing A.ts before deleting a.ts would delete the new file.
	const entries = Object.entries(answer.files).sort(([, a], [, b]) => Number(a !== null) - Number(b !== null));
	// Files new to the folder get the line endings git would give them, asked once for all of them.
	const fresh = newFileEndings(
		root,
		entries
			.filter(([rel, text]) => text !== null && !isLocalOnly(rel) && !existsSync(absolute(root, rel)))
			.map(([rel]) => rel),
	);
	for (const [rel, text] of entries) {
		if (isLocalOnly(rel)) {
			if (text !== null) dropped.add(rel);
			forgetKnown(root, rel);
			continue;
		}
		const path = absolute(root, rel);
		// Judged by its mode: a link is "" and is never followed.
		const now = onDisk(path, knownModes.get(rel) ?? PLAIN);
		const raw = now?.text;
		const disk = raw === undefined ? undefined : normalize(raw);
		const untouched = untouchedOnDisk(root, rel, now, knownBlobs);
		if (text === null) {
			if (!untouched) {
				kept.push(rel);
				continue;
			}
			const was = readKnown(root, rel);
			if (was !== undefined) gone.push({ path: rel, before: was, after: null });
			removeFile(path);
			forgetKnown(root, rel);
			knownModes.delete(rel);
			knownBlobs.delete(rel);
			delete unwritten[rel];
			deleted.push(rel);
		} else {
			if (disk === text) {
				writeKnown(root, rel, text);
				knownBlobs.delete(rel);
				delete unwritten[rel];
				continue;
			}
			if (!untouched) {
				kept.push(rel);
				continue;
			}
			if (!tryWrite(rel, () => writeFileAtomic(path, withEndingsOf(text, raw, fresh.get(rel))))) continue;
			if (now === undefined) arrived.push({ path: rel, before: null, after: text });
			writeKnown(root, rel, text);
			knownBlobs.delete(rel);
			written.push(rel);
		}
	}
	// Binary files: fetch the bytes the answer names, with the same care for unrecorded work.
	for (const [rel, sha] of Object.entries(answer.blobs ?? {})) {
		if (sha === null || isLocalOnly(rel)) continue;
		const path = absolute(root, rel);
		const now = onDisk(path, knownModes.get(rel) ?? PLAIN);
		const b = now === undefined ? undefined : blobOf(path);
		// Already this file: the same bytes, or (a file kept whole, #46) the same text with any line endings.
		if (
			(b !== undefined && "sha" in b && b.sha === sha) ||
			(now?.text !== undefined && keptWholeAs(normalize(now.text), sha))
		) {
			forgetKnown(root, rel);
			knownBlobs.set(rel, sha);
			delete unwritten[rel];
			continue;
		}
		if (!untouchedOnDisk(root, rel, now, knownBlobs)) {
			kept.push(rel);
			continue;
		}
		const bytes = await api.getBlob(sha);
		if (!tryWrite(rel, () => writeFileAtomic(path, bytes))) continue;
		forgetKnown(root, rel);
		knownBlobs.set(rel, sha);
		written.push(rel);
	}
	if (JSON.stringify([...knownBlobs]) !== blobsBefore) writeKnownBlobs(root, knownBlobs);
	// Modes after text: a link replaces the "" just written, and the bit goes on the file as written.
	for (const [rel, m] of Object.entries(answer.modes ?? {})) {
		if (isLocalOnly(rel) || kept.includes(rel) || answer.files[rel] === null || failed.has(rel)) continue;
		const was = knownModes.get(rel) ?? PLAIN;
		const mode: FullMode = { exec: m.exec ?? was.exec, link: m.link === undefined ? was.link : m.link };
		if (!tryWrite(rel, () => applyMode(absolute(root, rel), mode))) continue;
		knownModes.set(rel, mode);
		if (!written.includes(rel)) written.push(rel);
	}
	writeKnownModes(root, knownModes);
	if (dropped.size > 0) {
		heard(root, (await api.record(Object.fromEntries([...dropped].map((rel) => [rel, null])))).news);
		for (const rel of dropped) forgetKnown(root, rel);
	}
	const collisions = (answer.collisions ?? []).filter((c) => !isLocalOnly(c.file));
	const renamed =
		gone.length > 0 && arrived.length > 0
			? pairRenames([...gone, ...arrived])
					.filter((f) => f.from !== undefined)
					.map((f) => ({ from: f.from!, to: f.path }))
			: [];
	if (JSON.stringify(unwritten) !== unwrittenBefore)
		writeFileAtomic(join(root, AVCS_DIR, UNWRITTEN_FILE), `${JSON.stringify(unwritten, null, 1)}\n`);
	return {
		version: answer.version,
		written,
		deleted,
		kept,
		dropped: [...dropped].sort(),
		collisions,
		renamed,
		refused,
		merged: answer.merged ?? [],
		unwritten,
	};
}
