// Line diffs in git's unified format, from a file's text before and after.
// The server sends whole texts (null where a file doesn't exist); the client
// turns them into hunks, because agents already read git's format.

import type { FileChange } from "./api.ts";
import { editScript, linesOf } from "./core.ts";

/** git's default: a deleted and an added file are one renamed file when at least half of it is the same. */
export const RENAME_SIMILARITY = 50;
/** Past this many deleted or added files, renames are not looked for (git has diff.renameLimit for the same reason). */
const RENAME_LIMIT = 400;

/** How much of `a` and `b` is the same, 0-100: the lines they share over the longer one's lines. */
function similarity(a: string, b: string): number {
	if (a === b) return 100;
	const la = linesOf(a);
	const lb = linesOf(b);
	const longer = Math.max(la.length, lb.length);
	// Too different in length to reach the threshold: skip the diff.
	if (longer === 0 || Math.min(la.length, lb.length) * 100 < longer * RENAME_SIMILARITY) return 0;
	const same = editScript(la, lb).filter((o) => o.kind === " ").length;
	return Math.floor((same * 100) / longer);
}

/**
 * Pairs each deleted file with the added file most like it, as git does, so a
 * rename reads as one change (with its edits) instead of a delete and an add.
 * The server keeps each line's identity across a rename already (blame
 * follows it); this is how the change is shown.
 */
export function pairRenames(files: readonly FileChange[]): FileChange[] {
	const gone = files.filter(
		(f) => (f.before !== null && f.after === null) || (f.blob?.before && f.blob.after === null),
	);
	const added = files.filter(
		(f) => (f.before === null && f.after !== null) || (f.blob?.after && f.blob.before === null),
	);
	if (gone.length === 0 || added.length === 0 || gone.length > RENAME_LIMIT || added.length > RENAME_LIMIT)
		return [...files];
	const scored: { g: FileChange; a: FileChange; score: number }[] = [];
	for (const g of gone) {
		for (const a of added) {
			const score =
				g.blob?.before || a.blob?.after
					? g.blob?.before && g.blob.before === a.blob?.after
						? 100
						: 0
					: similarity(g.before!, a.after!);
			if (score >= RENAME_SIMILARITY) scored.push({ g, a, score });
		}
	}
	// Best matches first; ties go to the closer name, as a reader would guess.
	const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
	scored.sort(
		(x, y) =>
			y.score - x.score || Number(base(y.g.path) === base(y.a.path)) - Number(base(x.g.path) === base(x.a.path)),
	);
	const used = new Set<FileChange>();
	const renamed = new Map<FileChange, FileChange>();
	for (const { g, a, score } of scored) {
		if (used.has(g) || used.has(a)) continue;
		used.add(g).add(a);
		const mode = g.mode || a.mode ? { mode: { before: g.mode?.before ?? {}, after: a.mode?.after ?? {} } } : {};
		const blob = g.blob || a.blob ? { blob: { before: g.blob?.before ?? null, after: a.blob?.after ?? null } } : {};
		renamed.set(a, {
			path: a.path,
			from: g.path,
			similarity: score,
			before: g.before,
			after: a.after,
			...mode,
			...blob,
		});
	}
	return files.filter((f) => !used.has(f) || renamed.has(f)).map((f) => renamed.get(f) ?? f);
}

/** One file's change as git prints it: headers, then hunks with `context` lines around each change. */
export function unifiedDiff(change: FileChange, context = 3): string {
	const rename =
		change.from === undefined
			? []
			: [`similarity index ${change.similarity ?? 100}%`, `rename from ${change.from}`, `rename to ${change.path}`];
	if (change.blob !== undefined) {
		// As git says it: no lines to show, only that the bytes differ (here, which bytes, by hash).
		const name = (sha: string | null) => (sha === null ? "none" : sha.slice(0, 12));
		if (change.from !== undefined && change.blob.before === change.blob.after)
			return [...rename, ...modeLines(change)].join("\n");
		return [
			...rename,
			...modeLines(change),
			`Binary file ${change.path} changed: ${name(change.blob.before)} -> ${name(change.blob.after)}`,
		].join("\n");
	}
	const ops = editScript(linesOf(change.before), linesOf(change.after));
	// A rename with no edits is its header alone, as in git.
	if (change.from !== undefined && ops.every((o) => o.kind === " "))
		return [...rename, ...modeLines(change)].join("\n");
	const out = [
		...rename,
		...modeLines(change),
		`--- ${change.before === null ? "/dev/null" : `a/${change.from ?? change.path}`}`,
		`+++ ${change.after === null ? "/dev/null" : `b/${change.path}`}`,
	];
	// Positions (1-based) in the old and new file at the start of each op.
	const at: { a: number; b: number }[] = [];
	let ai = 1;
	let bi = 1;
	for (const op of ops) {
		at.push({ a: ai, b: bi });
		if (op.kind !== "+") ai++;
		if (op.kind !== "-") bi++;
	}
	let i = 0;
	while (i < ops.length) {
		if (ops[i]!.kind === " ") {
			i++;
			continue;
		}
		// A hunk: from `context` lines before this change to `context` lines after the last change within reach.
		const start = Math.max(0, i - context);
		let end = i;
		let j = i;
		while (j < ops.length) {
			if (ops[j]!.kind !== " ") {
				end = j;
				j++;
				continue;
			}
			let run = j;
			while (run < ops.length && ops[run]!.kind === " ") run++;
			if (run < ops.length && run - j <= 2 * context) j = run;
			else break;
		}
		const stop = Math.min(ops.length, end + 1 + context);
		const hunk = ops.slice(start, stop);
		const oldLen = hunk.filter((o) => o.kind !== "+").length;
		const newLen = hunk.filter((o) => o.kind !== "-").length;
		const oldStart = oldLen === 0 ? at[start]!.a - 1 : at[start]!.a;
		const newStart = newLen === 0 ? at[start]!.b - 1 : at[start]!.b;
		out.push(`@@ -${range(oldStart, oldLen)} +${range(newStart, newLen)} @@`);
		for (const o of hunk) out.push(`${o.kind}${o.line}`);
		i = stop;
	}
	return out.join("\n");
}

/** A change to the executable bit as git prints it, and a change of link target. */
function modeLines(change: FileChange): string[] {
	const m = change.mode;
	if (m === undefined) return [];
	const out: string[] = [];
	const execBefore = m.before.exec === true;
	const execAfter = m.after.exec === true;
	if (execBefore !== execAfter)
		out.push(`old mode ${execBefore ? "100755" : "100644"}`, `new mode ${execAfter ? "100755" : "100644"}`);
	const linkBefore = m.before.link ?? null;
	const linkAfter = m.after.link ?? null;
	if (linkBefore !== linkAfter) out.push(`link: ${linkBefore ?? "(not a link)"} -> ${linkAfter ?? "(not a link)"}`);
	return out;
}

/** A hunk's range as git writes it: the length is left out when it is 1. */
function range(start: number, length: number): string {
	return length === 1 ? String(start) : `${start},${length}`;
}

/** How many lines a change adds and removes. */
export function lineCounts(change: FileChange): { added: number; removed: number } {
	if (change.blob !== undefined) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const op of editScript(linesOf(change.before), linesOf(change.after))) {
		if (op.kind === "+") added++;
		else if (op.kind === "-") removed++;
	}
	return { added, removed };
}
