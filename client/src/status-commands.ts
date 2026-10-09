// abso status, and the small folder commands beside it: reader, mv, fix-eol
// and settle.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { isComposed, pathKey } from "../../worker/project/pathkey.ts";
import type { OpenCollision } from "./api.ts";
import { bool, type Parsed, UsageError } from "./args.ts";
import { readKnownBlobs, writeKnownBlobs } from "./blobs.ts";
import { ciText } from "./ci.ts";
import { newerCommitNote } from "./client-version.ts";
import { type Env, heard, type Output, open, plural } from "./command-env.ts";
import {
	LISTED,
	leftOutText,
	READER_REFUSES,
	readUnwritten,
	recordedFirst,
	recordFolder,
	turnedBinaryText,
	unwrittenText,
} from "./commands.ts";
import { credentialLabel, type Settings, writeConfig } from "./config.ts";
import { uncomposedText } from "./core.ts";
import {
	absolute,
	forgetKnown,
	isLocalOnly,
	listKnown,
	newFileEndings,
	normalize,
	readKnown,
	readText,
	unrecorded,
	writeFileAtomic,
	writeKnown,
} from "./folder.ts";
import { fileArg } from "./history.ts";
import { modsBehindText } from "./install.ts";
import { withFolderLock } from "./lock.ts";
import { readKnownModes, writeKnownModes } from "./modes.ts";
import { queueText } from "./queue.ts";
import { unsafePath } from "./safety.ts";
import { keepFrom, settleText } from "./settle.ts";
import { stateDir } from "./state-dir.ts";

// --- status ---

/**
 * Files in the agent's view that the folder lacks (#37: a join that got only
 * part of them). A file the agent deleted and hasn't recorded is in `pending`,
 * not here.
 */
export function missingHere(root: string, view: readonly string[], pending: ReadonlySet<string>): string[] {
	return view.filter((rel) => {
		if (pending.has(rel) || isLocalOnly(rel)) return false;
		try {
			lstatSync(absolute(root, rel));
			return false;
		} catch {
			return true;
		}
	});
}

/**
 * Recorded text files whose copy on disk differs from the record only by CRLF
 * line endings (#37: Python's text mode on Windows writes CRLF).
 * abso records them, and abso run sends them, with LF; a tool run here sees
 * CRLF. Files git would check out with CRLF are left out of the list.
 */
export function crlfOnly(root: string): string[] {
	const out: string[] = [];
	for (const rel of listKnown(root)) {
		const disk = readText(absolute(root, rel));
		if (disk === undefined || !disk.includes("\r")) continue;
		if (normalize(disk) === readKnown(root, rel)) out.push(rel);
	}
	const git = newFileEndings(root, out);
	return out.filter((rel) => git.get(rel) !== "crlf").sort();
}

/**
 * Whether the last edit here came from an older edit mod than the one
 * installed (#37, Reporter: a chat keeps the mod it started with, and an old
 * one sent files nested ignore files leave out). The mod writes its version
 * as the sixth field of each .avcs/hook.log line (from #33); the installed
 * one's is in its plugin.json. Says nothing until the installed mod carries a
 * commit, or when the last edit came from the mod as installed.
 */
export function staleModText(root: string, env: Readonly<Record<string, string | undefined>>): string[] {
	let installed: string | undefined;
	try {
		const dir = join(env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || "", ".claude"), "skills", "avcs");
		installed = String(
			(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version,
		);
	} catch {
		return [];
	}
	if (!installed.includes("+")) return [];
	let last: string[] | undefined;
	try {
		const lines = readFileSync(join(stateDir(root), "hook.log"), "utf8")
			.split("\n")
			.filter((l) => l.includes("(in process"));
		last = lines.at(-1)?.split("\t");
	} catch {
		return [];
	}
	if (last === undefined) return [];
	const sent = last[5]?.replace(/^avcs-mod\//, "");
	if (sent === installed || sent === "checkout") return [];
	const when = last[0] ? ` (at ${last[0].slice(11, 16)} UTC)` : "";
	return [
		`The last edit here${when} came from edit mod ${sent ?? "from before mods carried a version"}, but ${installed} is installed. A chat keeps the mod it started with; restart the chat that edits this folder to load the installed one.`,
	];
}

/** abso reader on|off: make this folder's agent a reader, or a writer again (#37, Reporter). */
export async function runReader(args: Parsed, env: Env): Promise<Output> {
	const word = args.positionals[0];
	if (args.positionals.length !== 1 || (word !== "on" && word !== "off"))
		throw new UsageError("abso reader on, or abso reader off");
	const { root, api } = open(env);
	const on = word === "on";
	// The server first: it refuses a reader with unpublished or parked work (409), and then nothing here changes.
	await api.reader(on);
	const raw = JSON.parse(readFileSync(join(stateDir(root), "config.json"), "utf8")) as Record<string, unknown>;
	if (on) raw.reader = true;
	else delete raw.reader;
	writeConfig(root, raw as unknown as Settings);
	return {
		text: on
			? "This folder is a reader now: status, sync, log, show, files and export work, and nothing it does is recorded or published. abso reader off undoes it."
			: "This folder records and publishes again.",
		json: { reader: on },
	};
}

/** Status's lines for marker blocks still in the draft (#11). */
export function openCollisionsText(open: readonly OpenCollision[]): string[] {
	if (open.length === 0) return [];
	return [
		`${plural(open.length, "collision")} to settle before you publish (keep yours, theirs or a mix and delete the marker lines, or abso settle <file> --yours|--theirs|--both):`,
		...open.map(
			(c) =>
				`  ${c.file} lines ${c.lines[0]}-${c.lines[1]}, with ${c.theirs.agent}'s version ${c.theirs.version} ("${c.theirs.message}")`,
		),
	];
}

/** abso fix-eol: rewrite the files that differ from the record only in line endings with LF, as recorded (#37). */
/**
 * abso mv <from> <to> (#49): move a file in the draft,
 * its lines keeping their history, as git mv. The way to change a file's case
 * (or its Unicode spelling), since two spellings of one name are one file.
 */
export async function runMv(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 2) throw new UsageError("mv takes the file and its new name: abso mv <from> <to>");
	const { root, config, api } = open(env);
	if (config.reader) throw new UsageError(READER_REFUSES);
	const from = fileArg(root, env.cwd, args.positionals[0]!);
	const to = fileArg(root, env.cwd, args.positionals[1]!);
	if (from === to) throw new UsageError(`${from} already has that name`);
	const bad =
		unsafePath(to) ??
		(isLocalOnly(to) ? "it is under .git, .claude, .avcs or node_modules, which stay local" : undefined);
	if (bad !== undefined) throw new UsageError(`can't move to ${to}: ${bad}`);
	const fromPath = absolute(root, from);
	const toPath = absolute(root, to);
	if (!existsSync(fromPath)) throw new UsageError(`${from} isn't in this folder`);
	// A new case (or Unicode spelling) of the same name is the same file on Windows and macOS; anything else must be free.
	const sameFile = pathKey(from) === pathKey(to);
	if (!sameFile && existsSync(toPath)) throw new UsageError(`${to} already exists; move or delete it first`);
	// Edits not yet sent go first, so the move carries the file as it is.
	await recordFolder(root, api);
	const answer = await api.move(from, to);
	heard(root, answer.news);
	await withFolderLock(root, "mv", async () => {
		mkdirSync(dirname(toPath), { recursive: true });
		renameSync(fromPath, toPath);
		const text = readKnown(root, from);
		forgetKnown(root, from);
		if (text !== undefined) writeKnown(root, to, text);
		const modes = readKnownModes(root);
		const mode = modes.get(from);
		if (mode !== undefined) {
			modes.delete(from);
			modes.set(to, mode);
			writeKnownModes(root, modes);
		}
		const blobs = readKnownBlobs(root);
		const sha = blobs.get(from);
		if (sha !== undefined) {
			blobs.delete(from);
			blobs.set(to, sha);
			writeKnownBlobs(root, blobs);
		}
	});
	return {
		text: [
			`Moved ${from} to ${to} in your draft; its lines keep their history. It reaches shared with your next publish.`,
			...(isComposed(to) ? [] : [uncomposedText(to)]),
		].join("\n"),
		json: { from: answer.from, to: answer.to },
	};
}

export async function runFixEol(_args: Parsed, env: Env): Promise<Output> {
	const { root } = open(env);
	const crlf = crlfOnly(root);
	for (const rel of crlf) writeFileAtomic(absolute(root, rel), readText(absolute(root, rel))!.replace(/\r\n?/g, "\n"));
	return {
		text:
			crlf.length === 0
				? "No file differs from the record only in line endings."
				: `Rewrote ${plural(crlf.length, "file")} with LF line endings; their text is unchanged, so nothing is recorded.`,
		json: { files: crlf },
	};
}

/** abso settle <file...> --yours | --theirs | --both: rewrite each file's marker blocks, then record (#11). */
export async function runSettle(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length === 0)
		throw new UsageError("name the files to settle: abso settle <file...> --yours, --theirs or --both");
	const keep = keepFrom({ yours: bool(args, "yours"), theirs: bool(args, "theirs"), both: bool(args, "both") });
	const { root, api } = open(env);
	const files = args.positionals.map((typed) => fileArg(root, env.cwd, typed));
	const counts: [string, number][] = [];
	for (const rel of files) {
		const text = readText(absolute(root, rel));
		if (text === undefined) throw new UsageError(`${rel} is not a text file in this folder`);
		const settled = settleText(text, keep);
		if (settled.blocks === 0)
			throw new UsageError(`${rel} has no collision markers to settle (abso status lists the files that do)`);
		counts.push([rel, settled.blocks]);
	}
	// Each file checked first, so a typo settles nothing.
	for (const [rel] of counts)
		writeFileAtomic(absolute(root, rel), settleText(readText(absolute(root, rel))!, keep).text);
	const recorded = await recordFolder(root, api);
	const which = keep === "both" ? "both sides" : keep;
	return {
		text: [
			...recordedFirst(recorded).filter((l) => !l.startsWith("Recorded first")),
			`Settled ${counts.map(([rel, n]) => `${plural(n, "block")} in ${rel}`).join(", ")}, keeping ${which}.${keep === "both" ? " Both sides stay in the file; when you publish, the other author hears that you kept both." : ""}`,
		].join("\n"),
		json: { keep, files: counts.map(([file, blocks]) => ({ file, blocks })), recorded: recorded.sent },
	};
}

/** The line status prints for files the folder is missing. */
export function missingText(missing: readonly string[]): string[] {
	if (missing.length === 0) return [];
	const some =
		missing.length <= LISTED
			? missing.join(", ")
			: `${missing.slice(0, LISTED).join(", ")}, and ${missing.length - LISTED} more`;
	return [
		`Missing from this folder though your view has ${missing.length === 1 ? "it" : "them"} (abso sync --full writes ${missing.length === 1 ? "it" : "them"}; abso files lists them all): ${some}`,
	];
}

export async function runStatus(args: Parsed, env: Env): Promise<Output> {
	const { root, config, api } = open(env);
	const short = bool(args, "short");
	const { files: view, ...status } = short ? { ...(await api.status()), files: undefined } : await api.statusAndFiles();
	const pending = unrecorded(root);
	const local = new Set([...pending.files.keys(), ...pending.blobs.keys(), ...Object.keys(pending.modes)]);
	if (short) {
		// One word to stamp a build with (#37, Playtester 1): 214, coast@3, 214+unpublished.
		const me = status.agents.find((a) => a.agent === config.agent);
		const unpublished = local.size > 0 || (me?.draftChanges ?? 0) > 0;
		// +queued: published into the merge queue, not landed yet (#39).
		const word = `${me?.draft ? `${me.draft}@` : ""}${me?.base ?? "none"}${unpublished ? "+unpublished" : ""}${(me?.queued?.length ?? 0) > 0 ? "+queued" : ""}`;
		return { text: word, json: { version: me?.base ?? null, draft: me?.draft ?? null, unpublished, word } };
	}
	const missing = view === undefined ? [] : missingHere(root, view.files, local);
	const unwritten = readUnwritten(root);
	const crlf = crlfOnly(root);
	// Files an earlier record added to the draft and that are gone again (#37: scratch files a run
	// recorded, deleted after): nothing reached shared, and the next record takes them out of the draft.
	const deleted = [...pending.files].filter(([, text]) => text === null).map(([rel]) => rel);
	const neverShared =
		deleted.length === 0
			? []
			: (await api.diff()).files
					.filter((f) => f.before === null && deleted.includes(f.path))
					.map((f) => f.path)
					.sort();
	for (const rel of neverShared) local.delete(rel);
	const me = status.agents.find((a) => a.agent === config.agent);
	const space = (draft: string | null | undefined): string => (draft ? `draft ${draft}` : "shared");
	const parked = (me?.parked ?? []).filter((p) => p.draftChanges > 0);
	const credential = credentialLabel(root, config.server, env.env);
	const behind = await newerCommitNote(config.server);
	const lines = [
		`Project ${config.project}: shared is at version ${status.version}. This folder is ${config.agent}${config.reader || me?.reader ? ", a reader (it records and publishes nothing)" : ""}, working in ${space(me?.draft)}.${config.follow ? ` It follows label ${config.follow}: syncs take it to the newest version with that label.` : ""} Signed in with ${credential.kind}${credential.id ? ` ${credential.id}` : ""}.`,
		...(behind ? [behind] : []),
		// Is shared green (#39)? Right under the first line, since it decides what to do next.
		...ciText(status.ci, status.version),
		...queueText(status.queue, config.agent),
		...(status.projectFile
			? [
					`Shared has both ${status.projectFile.used} and ${status.projectFile.ignored}: ${status.projectFile.used} counts and ${status.projectFile.ignored} is ignored. Move anything you need into ${status.projectFile.used} and delete ${status.projectFile.ignored}.`,
				]
			: []),
		local.size === 0
			? "Everything in this folder is recorded."
			: `Not yet recorded (abso record sends them): ${[...local.keys()].join(", ")}`,
		...(neverShared.length > 0
			? [
					`Added to your draft by an earlier record and deleted since, so they never reach shared; the next record (sync, publish, run) takes them out of your draft: ${neverShared.join(", ")}`,
				]
			: []),
		...openCollisionsText(me?.collisions ?? []),
		...staleModText(root, env.env),
		...modsBehindText(env.env),
		...missingText(missing),
		...unwrittenText(unwritten),
		...(crlf.length > 0
			? [
					`${plural(crlf.length, "file")} differ${crlf.length === 1 ? "s" : ""} from what abso recorded only in line endings (CRLF here; abso records and abso run sends LF). Harmless; abso fix-eol rewrites ${crlf.length === 1 ? "it" : "them"} with LF.`,
				]
			: []),
		...turnedBinaryText(pending.turnedBinary),
		...leftOutText(pending.leftOut),
		...(parked.length > 0
			? [
					`You have work parked in ${parked.map((p) => `${space(p.draft)} (${plural(p.draftChanges, "change")})`).join(", ")}; abso switch brings it back.`,
				]
			: []),
		"Agents:",
		...status.agents.map((a) => {
			const files = Array.isArray(a.files)
				? a.files.length === 0
					? ""
					: `: ${a.files.join(", ")}`
				: ` in ${plural(a.files as number, "file")}`;
			const where = a.draft ? ` in draft ${a.draft},` : "";
			return `  ${a.agent === config.agent ? "*" : " "} ${a.agent},${where} base ${a.base ?? "none"}, ${plural(a.draftChanges, "draft change")}${files}`;
		}),
		...((status.drafts ?? []).length > 0
			? [
					"Named drafts:",
					...(status.drafts ?? []).map(
						(d) =>
							`  ${d.name}: version ${d.version}, on shared version ${d.sharedBase}, ${plural(d.changes, "change")} not yet landed${d.agents.length > 0 ? `; ${d.agents.join(", ")}` : ""}`,
					),
				]
			: []),
	];
	return {
		text: lines.join("\n"),
		json: {
			...status,
			agent: config.agent,
			credential,
			follow: config.follow ?? null,
			unrecorded: [...local.keys()],
			neverShared,
			missing,
			unwritten,
			crlf,
			leftOut: pending.leftOut,
		},
	};
}
