// abso diff, log, show and restore: the everyday commands of #27.
//
// diff and restore work on this agent's unpublished changes. log, show and
// diff between versions read the published versions of the space this folder
// is in (shared or a named draft) unless --draft names another.

import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Api, FileChange, LogAnswer, LogEntry, Where } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { globTest } from "./at.ts";
import { readKnownBlobs, writeKnownBlobs } from "./blobs.ts";
import { ciMarkText } from "./ci.ts";
import { type Env, EXIT, missingHere, type Output, open, plural, recordedFirst, recordFolder } from "./commands.ts";
import { editScript, linesOf, normalize, withEndingsOf } from "./core.ts";
import { lineCounts, pairRenames, unifiedDiff } from "./diff.ts";
import {
	absolute,
	forgetKnown,
	newFileEndings,
	readText,
	removeFile,
	unrecorded,
	writeFileAtomic,
	writeKnown,
} from "./folder.ts";
import { fileArg, when } from "./history.ts";
import { applyMode, PLAIN, readKnownModes, writeKnownModes } from "./modes.ts";
import { refusedText, screenAnswer } from "./safety.ts";

/** The space to read: --draft (where "shared" means shared), else the one this agent is in. */
function space(args: Parsed, agent: string): Where {
	const named = str(args, "draft");
	if (named === undefined) return { agent };
	return { draft: named === "shared" ? null : named };
}

function spaceName(draft: string | null): string {
	return draft === null ? "shared" : `draft ${draft}`;
}

/** How to name a space in a sentence when only the request says which it is. */
function whereName(where: Where): string {
	return "agent" in where ? "your space" : spaceName(where.draft);
}

function version(raw: string, what = "a version"): number {
	const n = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n))
		throw new UsageError(`${what} is a version number (got ${JSON.stringify(raw)})`);
	return n;
}

/**
 * abso files [glob...] [--draft <name>] [--version N]: the files a view holds
 * (#37). Without flags, this agent's view, what the folder should hold, with
 * any the folder lacks marked; with --draft or --version, that space at that
 * version as published.
 */
export async function runFiles(args: Parsed, env: Env): Promise<Output> {
	const { root, config, api } = open(env);
	const rawVersion = str(args, "version");
	const at = rawVersion === undefined ? undefined : version(rawVersion, "--version");
	const where = space(args, config.agent);
	const mine = "agent" in where && at === undefined;
	// --version alone reads the space this agent is in, which only its view names.
	const answer = mine
		? await api.viewFiles()
		: await api.filesAt("agent" in where ? (await api.viewFiles()).draft : where.draft, at);
	const match = args.positionals.length === 0 ? () => true : globTest(args.positionals.join(","));
	const files = answer.files.filter((f) => match(f));
	const pending = mine ? unrecorded(root) : undefined;
	const missing = new Set(
		pending
			? missingHere(
					root,
					files,
					new Set([...pending.files.keys(), ...pending.blobs.keys(), ...Object.keys(pending.modes)]),
				)
			: [],
	);
	const what =
		args.positionals.length === 0
			? plural(files.length, "file")
			: `${plural(files.length, "file")} matching ${args.positionals.join(", ")}`;
	return {
		text: [
			mine
				? `Your view holds ${what}: ${spaceName(answer.draft)} at version ${answer.version}, with your unpublished changes.${missing.size > 0 ? ` ${missing.size} of them ${missing.size === 1 ? "is" : "are"} missing from this folder (abso sync --full writes them).` : ""}`
				: `${spaceName(answer.draft)} at version ${answer.version} holds ${what}.`,
			...files.map((f) => (missing.has(f) ? `${f}  (missing from this folder)` : f)),
		].join("\n"),
		json: { version: answer.version, draft: answer.draft, files, ...(mine ? { missing: [...missing] } : {}) },
	};
}

/** The diffs, and a JSON form that carries each file's diff text and line counts. */
function diffs(files: readonly FileChange[]): { text: string[]; json: unknown[] } {
	const text: string[] = [];
	const json: unknown[] = [];
	for (const f of files) {
		const diff = unifiedDiff(f);
		text.push(diff);
		json.push({ ...f, ...lineCounts(f), diff });
	}
	return { text, json };
}

function totals(files: readonly FileChange[]): string {
	let added = 0;
	let removed = 0;
	for (const f of files) {
		const c = lineCounts(f);
		added += c.added;
		removed += c.removed;
	}
	const renamed = files.filter((f) => f.from !== undefined).length;
	return `${plural(files.length, "file")}${renamed > 0 ? ` (${renamed} renamed)` : ""}, ${plural(added, "line")} added, ${removed} removed`;
}

/** Whether a change is to `p` (a file or a folder): a renamed file counts under its old path and its new one. */
function touches(f: FileChange, p: string): boolean {
	return under(f.path, p) || (f.from !== undefined && under(f.from, p));
}

export async function runDiff(args: Parsed, env: Env): Promise<Output> {
	const { root, config, api } = open(env);
	const words = args.positionals;
	const between = words.length >= 2 && /^\d+$/.test(words[0]!) && /^\d+$/.test(words[1]!);
	const only = (between ? words.slice(2) : words).map((w) => pathArg(root, env.cwd, w));
	// Renames are paired over every file first, so a path picks the whole rename.
	const pick = (files: readonly FileChange[]) => {
		const all = pairRenames(files);
		return only.length === 0 ? all : all.filter((f) => only.some((p) => touches(f, p)));
	};
	// Each path that matched nothing gets a line of its own, saying whether it is even there.
	const unmatched = (files: readonly FileChange[]) => only.filter((p) => !files.some((f) => touches(f, p)));
	const notes = (files: readonly FileChange[]) =>
		unmatched(files)
			.filter((p) => only.length > 1 || !existsHere(root, p))
			.map((p) => nothingAt(root, p));

	if (between) {
		const from = version(words[0]!);
		const to = version(words[1]!);
		const where = space(args, config.agent);
		const answer = await api.compare(from, to, where);
		const files = pick(answer.files);
		const d = diffs(files);
		const head =
			files.length === 0
				? `No differences between versions ${from} and ${to} of ${whereName(where)}${inPaths(only)}.`
				: `From version ${from} to ${to} of ${whereName(where)}${inPaths(only)}: ${totals(files)}.`;
		return {
			text: [head, ...notes(files), ...d.text].join("\n"),
			json: { ...where, from, to, files: d.json, unmatched: unmatched(files) },
		};
	}

	if (str(args, "draft") !== undefined)
		throw new UsageError(
			"--draft goes with two versions (abso diff <from> <to>); abso diff alone shows your own unpublished changes",
		);
	// Folder-only edits count as unpublished changes too.
	const recorded = await recordFolder(root, api);
	const answer = await api.diff();
	const files = pick(answer.files);
	const d = diffs(files);
	const where = `${spaceName(answer.draft)}${answer.base === null ? "" : ` (on version ${answer.base})`}`;
	const head =
		files.length === 0
			? `No unpublished changes${inPaths(only, "to")} in ${where}.`
			: `Your unpublished changes${inPaths(only, "to")} in ${where}: ${totals(files)}.`;
	const pre = recordedFirst(recorded);
	return {
		text: [...pre, head, ...notes(files), ...d.text].join("\n"),
		json: {
			draft: answer.draft,
			base: answer.base,
			files: d.json,
			recorded: recorded.sent,
			unmatched: unmatched(files),
		},
	};
}

const LOG_FILES = 8;
/** How far back `abso log <folder>` looks, since the client filters it. */
const FOLDER_LOG = 1000;

/** A path as typed, folder-relative: "" for the whole folder. A folder stands for every file under it. */
function pathArg(root: string, cwd: string, typed: string): string {
	if (relative(root, resolve(cwd, typed)) === "") return "";
	return fileArg(root, cwd, typed);
}

/** Whether `path` is `p`, or under the folder `p` ("" is everything). */
function under(path: string, p: string): boolean {
	return p === "" || path === p || path.startsWith(`${p}/`);
}

function isFolder(root: string, p: string): boolean {
	try {
		return statSync(absolute(root, p)).isDirectory();
	} catch {
		return false;
	}
}

function existsHere(root: string, p: string): boolean {
	return p === "" || existsSync(absolute(root, p));
}

/** The line for a path that matched no changed file. */
function nothingAt(root: string, p: string): string {
	if (!existsHere(root, p))
		return `  ${p}: no such file or folder here now (paths are relative to where you run avcs).`;
	return `  ${p === "" ? "the whole folder" : `${p}${isFolder(root, p) ? "/" : ""}`}: no changes there.`;
}

/** " in a.ts, harness" (or " to ...") for the paths a command was limited to. */
function inPaths(only: readonly string[], word = "in"): string {
	return only.length === 0 ? "" : ` ${word} ${only.map((p) => (p === "" ? "the whole folder" : p)).join(", ")}`;
}

/** How many renames `abso log <file>` follows back. */
const FOLLOW_RENAMES = 20;

type FollowedEntry = LogEntry & { readonly renamedFrom?: string };

/**
 * A file's log that goes on past a rename, like `git log --follow`: where the
 * oldest version found is the one that renamed the file into being, the
 * versions before it come from the old path's log.
 */
async function followRenames(
	api: Api,
	where: Where,
	path: string,
	first: LogAnswer,
	limit: number | undefined,
): Promise<FollowedEntry[]> {
	const versions: FollowedEntry[] = [...first.versions];
	let current = path;
	for (let hops = 0; hops < FOLLOW_RENAMES; hops++) {
		if (limit !== undefined && versions.length >= limit) break;
		const oldest = versions[versions.length - 1];
		if (oldest === undefined || oldest.version === 0) break;
		const renamed = pairRenames((await api.show(oldest.version, where)).diff).find(
			(f) => f.path === current && f.from !== undefined,
		);
		if (renamed === undefined) break;
		versions[versions.length - 1] = { ...oldest, renamedFrom: renamed.from! };
		const earlier = (await api.log(where, FOLDER_LOG, renamed.from)).versions.filter((v) => v.version < oldest.version);
		versions.push(...earlier.slice(0, limit === undefined ? 50 : limit - versions.length));
		current = renamed.from!;
	}
	return versions;
}

/** What else a version says: its labels, what it dropped or what dropped it, and its first message when amended. */
function notes(v: FollowedEntry): string[] {
	const out: string[] = [];
	if (v.renamedFrom !== undefined)
		out.push(`  renamed from ${v.renamedFrom}; the versions below are its history under that name`);
	if (v.labels && v.labels.length > 0) out.push(`  labels: ${v.labels.join(", ")}`);
	if (v.drops && v.drops.length > 0)
		out.push(`  drops ${v.drops.length === 1 ? "version" : "versions"} ${v.drops.join(", ")}`);
	if (v.droppedIn !== undefined) out.push(`  dropped in version ${v.droppedIn}: shared no longer has these changes`);
	if (v.originalMessage !== undefined) out.push(`  amended; first published as: ${v.originalMessage}`);
	return out;
}

/**
 * --since: a version number (the versions after it), a span back from now
 * (30m, 2h, 1d), or a date and time Date.parse reads (2026-10-05T17:00).
 */
export function sinceTest(raw: string, now: number): (v: LogEntry) => boolean {
	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		return (v) => v.version > n;
	}
	const span = /^(\d+)\s*(m|min|h|d)$/.exec(raw);
	// A bare clock time (20:00) is today's, local; yesterday's when today's hasn't come yet (#37, Reporter).
	const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
	const today = (h: number, m: number) => {
		const d = new Date(now);
		d.setHours(h, m, 0, 0);
		return d.getTime() > now ? d.getTime() - 86_400_000 : d.getTime();
	};
	const at = span
		? now -
			Number(span[1]) * { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m" | "min" | "h" | "d"]
		: clock && Number(clock[1]) < 24 && Number(clock[2]) < 60
			? today(Number(clock[1]), Number(clock[2]))
			: Date.parse(raw);
	if (Number.isNaN(at))
		throw new UsageError(
			`--since takes a version (400), a span back from now (30m, 2h, 1d), a clock time today (20:00), or a date and time (2026-10-05T17:00); got ${JSON.stringify(raw)}`,
		);
	return (v) => v.time >= at;
}

export async function runLog(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1)
		throw new UsageError("log takes at most one file: abso log [file] [-n <count>] [--draft <name>]");
	const { root, config, api } = open(env);
	const typed = args.positionals[0];
	const path = typed === undefined ? undefined : pathArg(root, env.cwd, typed);
	const rawLimit = str(args, "limit");
	const limit = rawLimit === undefined ? undefined : version(rawLimit, "-n");
	if (limit === 0) throw new UsageError("-n is how many versions to show; give 1 or more");
	// The server filters by one file; a folder (or the whole folder) is filtered here, from a longer log.
	const folder = path !== undefined && (path === "" || /[/]$/.test(typed!) || isFolder(root, path));
	// --since, --by and --count (#37, Reporter's progress reports) filter here, from a longer log.
	const since = str(args, "since");
	const by = str(args, "by");
	const count = bool(args, "count");
	const filtering = since !== undefined || by !== undefined || count;
	const keep = since === undefined ? () => true : sinceTest(since, Date.now());
	const agents =
		by === undefined
			? undefined
			: new Set(
					by
						.split(",")
						.map((a) => a.trim())
						.filter((a) => a !== ""),
				);
	const raw = await api.log(
		space(args, config.agent),
		folder || filtering ? FOLDER_LOG : limit,
		folder ? undefined : path,
	);
	const found = folder
		? {
				...raw,
				versions: raw.versions
					.filter((v) => v.files.some((f) => under(f, path!)))
					.slice(0, filtering ? FOLDER_LOG : (limit ?? 50)),
			}
		: path !== undefined
			? {
					...raw,
					versions: await followRenames(api, space(args, config.agent), path, raw, filtering ? FOLDER_LOG : limit),
				}
			: raw;
	const answer = filtering
		? {
				...found,
				versions: found.versions
					.filter((v) => keep(v) && (agents === undefined || agents.has(v.agent)))
					.slice(0, limit ?? FOLDER_LOG),
			}
		: found;
	if (count) {
		// Versions and files per agent, most first.
		const per = new Map<string, { versions: number; files: Set<string> }>();
		for (const v of answer.versions) {
			const a = per.get(v.agent) ?? { versions: 0, files: new Set<string>() };
			a.versions++;
			for (const f of v.files) a.files.add(f);
			per.set(v.agent, a);
		}
		const rows = [...per].sort(([a, x], [b, y]) => y.versions - x.versions || a.localeCompare(b));
		const scope = [
			since === undefined ? "" : /^\d+$/.test(since) ? ` since version ${since}` : ` since ${since}`,
			agents === undefined ? "" : ` by ${[...agents].join(", ")}`,
		].join("");
		return {
			text: [
				`${spaceName(answer.draft)} is at version ${answer.version}. ${plural(answer.versions.length, "version")}${scope}${answer.versions.length > 0 ? ", per agent:" : "."}`,
				...rows.map(([agent, a]) => `  ${agent}: ${plural(a.versions, "version")}, ${plural(a.files.size, "file")}`),
			].join("\n"),
			json: {
				draft: answer.draft,
				version: answer.version,
				versions: answer.versions.length,
				agents: Object.fromEntries(rows.map(([agent, a]) => [agent, { versions: a.versions, files: a.files.size }])),
			},
		};
	}
	const named = path === undefined ? "" : path === "" ? "the whole folder" : folder ? `${path}/` : path;
	const lines = [
		`${spaceName(answer.draft)} is at version ${answer.version}.${path === undefined ? "" : answer.versions.length === 0 ? ` No version changed ${named}.` : ` The versions that changed ${named}, newest first:`}`,
		...(path !== undefined && answer.versions.length === 0 && !existsHere(root, path) ? [nothingAt(root, path)] : []),
		...answer.versions.flatMap((v) => [
			`version ${v.version} by ${v.agent}, ${when(v.time)}${answer.draft === null ? ciMarkText(v.ci) : ""}: ${v.message}`,
			`  ${plural(v.files.length, "file")}: ${v.files.slice(0, LOG_FILES).join(", ")}${v.files.length > LOG_FILES ? `, and ${v.files.length - LOG_FILES} more` : ""}`,
			...notes(v),
		]),
	];
	const oldest = answer.versions[answer.versions.length - 1];
	if (path === undefined && !filtering && oldest !== undefined && oldest.version > 0)
		lines.push(`Older versions: abso log -n ${answer.versions.length + 50}`);
	if (filtering && answer.versions.length === 0) lines.push("No version matches.");
	return { text: lines.join("\n"), json: { ...answer } };
}

export async function runShow(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError("show takes one version: abso show <version> or abso show <version>:<file>");
	const { root, config, api } = open(env);
	const word = args.positionals[0]!;
	const colon = word.indexOf(":");
	const where = space(args, config.agent);

	if (colon >= 0) {
		const v = version(word.slice(0, colon));
		const path = fileArg(root, env.cwd, word.slice(colon + 1));
		const answer = await api.fileAt(path, v, where);
		if (answer.text === null)
			return {
				exit: EXIT.error,
				text: `${path} did not exist at version ${v} of ${whereName(where)}.`,
				json: { ...answer, ...where },
			};
		return { text: answer.text, json: { ...answer, ...where } };
	}

	const answer = await api.show(version(word), where);
	const changed = pairRenames(answer.diff);
	const d = diffs(changed);
	const lines = [
		`version ${answer.version} of ${spaceName(answer.draft)} by ${answer.agent}, ${when(answer.time)}: ${answer.message}`,
		...notes(answer),
		changed.length === 0 ? "It changed no files." : `${totals(changed)}.`,
		...d.text,
	];
	return { text: lines.join("\n"), json: { ...answer, diff: d.json } };
}

/**
 * A file's text with the draft's hunks that touch lines `from`-`to` (of the
 * file as it is now, as abso diff numbers them) put back as they were at the
 * base; the other hunks stay (#37, Builder 2: drop my copy of a teammate's
 * half and keep the rest). A hunk that only deleted lines touches the line
 * where they were.
 */
export function restoreLines(before: string, after: string, from: number, to: number): { text: string; hunks: number } {
	const ops = editScript(linesOf(before), linesOf(after));
	const out: string[] = [];
	let hunks = 0;
	let line = 1; // the next line of the file as it is now
	for (let i = 0; i < ops.length; ) {
		if (ops[i]!.kind === " ") {
			out.push(ops[i]!.line);
			line++;
			i++;
			continue;
		}
		// One hunk: the run of - and + ops.
		let j = i;
		while (j < ops.length && ops[j]!.kind !== " ") j++;
		const run = ops.slice(i, j);
		const added = run.filter((o) => o.kind === "+").length;
		const first = line;
		const last = added > 0 ? line + added - 1 : line;
		const touched = added > 0 ? first <= to && last >= from : first >= from && first <= to + 1;
		if (touched) {
			out.push(...run.filter((o) => o.kind === "-").map((o) => o.line));
			hunks++;
		} else {
			out.push(...run.filter((o) => o.kind === "+").map((o) => o.line));
		}
		line += added;
		i = j;
	}
	return { text: out.length === 0 ? "" : `${out.join("\n")}\n`, hunks };
}

/** file:12 or file:12-30, as typed; not a Windows drive letter (C:...). */
const LINES = /^(.+?):(\d+)(?:-(\d+))?$/;

export async function runRestore(args: Parsed, env: Env): Promise<Output> {
	const all = bool(args, "all");
	if (all === args.positionals.length > 0)
		throw new UsageError(
			"restore takes files, or --all: abso restore <file...> | abso restore <file>:<lines> | abso restore --all",
		);
	const { root, api } = open(env);
	const ranged = args.positionals
		.map((w) => LINES.exec(w))
		.filter((m): m is RegExpExecArray => m !== null && !/^[A-Za-z]$/.test(m[1]!))
		.map((m) => ({ file: fileArg(root, env.cwd, m[1]!), from: Number(m[2]), to: Number(m[3] ?? m[2]), typed: m[0] }));
	const asked = args.positionals
		.filter((w) => !ranged.some((r) => r.typed === w))
		.map((w) => fileArg(root, env.cwd, w));
	// Folder-only edits go to the server first, so they are discarded with the rest.
	await recordFolder(root, api);
	if (ranged.length > 0) {
		// Some lines of a file: put those hunks back here, then record the file (#37, Builder 2).
		const diff = await api.diff();
		const lines: string[] = [];
		for (const r of ranged) {
			if (r.to < r.from) throw new UsageError(`${r.typed}: the range runs backwards`);
			const change = diff.files.find((f) => f.path === r.file);
			if (change === undefined || change.before === null || change.after === null || change.blob !== undefined) {
				throw new UsageError(
					`${r.file} has no line changes in your draft to restore (abso diff ${r.file} shows what it has)`,
				);
			}
			const back = restoreLines(change.before, change.after, r.from, r.to);
			if (back.hunks === 0)
				throw new UsageError(
					`none of your changes to ${r.file} touch lines ${r.from}-${r.to} (abso diff ${r.file} shows where they are)`,
				);
			const path = absolute(root, r.file);
			writeFileAtomic(path, withEndingsOf(back.text, readText(path), undefined));
			lines.push(
				`Restored ${plural(back.hunks, "hunk")} of ${r.file} at ${r.from === r.to ? `line ${r.from}` : `lines ${r.from}-${r.to}`} to how ${diff.base === null ? "shared" : `version ${diff.base}`} has ${back.hunks === 1 ? "it" : "them"}; your other changes to it stay.`,
			);
		}
		await recordFolder(root, api);
		if (asked.length === 0)
			return {
				text: lines.join("\n"),
				json: { restoredLines: ranged.map((r) => ({ file: r.file, from: r.from, to: r.to })) },
			};
	}
	// The server's own paths, screened as a sync's are (safety.ts).
	const { answer, refused } = screenAnswer(root, await api.restore(all ? null : asked));
	const restored: string[] = [];
	const deleted: string[] = [];
	const fresh = newFileEndings(
		root,
		Object.entries(answer.files)
			.filter(([rel, text]) => text !== null && !existsSync(absolute(root, rel)))
			.map(([rel]) => rel),
	);
	for (const [rel, text] of Object.entries(answer.files).sort(
		([, a], [, b]) => Number(a !== null) - Number(b !== null),
	)) {
		const path = absolute(root, rel);
		if (text === null) {
			removeFile(path);
			forgetKnown(root, rel);
			deleted.push(rel);
		} else {
			const raw = readText(path);
			writeFileAtomic(path, withEndingsOf(text, raw, fresh.get(rel)));
			writeKnown(root, rel, normalize(text));
			restored.push(rel);
		}
	}
	const knownModes = readKnownModes(root);
	for (const rel of deleted) knownModes.delete(rel);
	for (const [rel, m] of Object.entries(answer.modes ?? {})) {
		if (answer.files[rel] === null) continue;
		const was = knownModes.get(rel) ?? PLAIN;
		const mode = { exec: m.exec ?? was.exec, link: m.link === undefined ? was.link : m.link };
		applyMode(absolute(root, rel), mode);
		knownModes.set(rel, mode);
		if (!restored.includes(rel)) restored.push(rel);
	}
	writeKnownModes(root, knownModes);
	// Binary files go back to the bytes the server has.
	const knownBlobs = readKnownBlobs(root);
	for (const rel of [...deleted, ...Object.keys(answer.files)]) knownBlobs.delete(rel);
	for (const [rel, sha] of Object.entries(answer.blobs ?? {})) {
		if (sha === null) continue;
		writeFileAtomic(absolute(root, rel), await api.getBlob(sha));
		forgetKnown(root, rel);
		knownBlobs.set(rel, sha);
		if (!restored.includes(rel)) restored.push(rel);
	}
	writeKnownBlobs(root, knownBlobs);
	const untouched = asked.filter(
		(rel) => !(rel in answer.files) && !(rel in (answer.modes ?? {})) && !(rel in (answer.blobs ?? {})),
	);
	const lines = [
		restored.length + deleted.length === 0
			? "Nothing to restore: no unpublished changes there."
			: `Discarded your unpublished changes to ${plural(restored.length + deleted.length, "file")}:`,
		...restored.map((f) => `  restored ${f}`),
		...deleted.map((f) => `  deleted ${f} (it is new in your draft)`),
		...(untouched.length > 0 && restored.length + deleted.length > 0
			? [`No unpublished changes to: ${untouched.join(", ")}`]
			: []),
		...refusedText(refused),
	];
	return { text: lines.join("\n"), json: { restored, deleted, untouched, dropped: answer.dropped, refused } };
}
