// Build scored test cases from a project's past settles (#19), read through the
// abso client in a seat folder joined to that project (a reader seat is enough).
//
//   node scripts/autosettle/extract.ts <seat folder> <cases.json> [--since 8d]
//
// For each settle: the file before theirs (their version - 1, the best guess at
// what both started from), theirs, and the settle's result. git's line diff
// finds each of their hunks that the settler's change touched. The held agent's
// own lines are only recoverable from the result when it kept yours or both;
// otherwise "yours" is null and score.ts skips the case.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [seat, out] = process.argv.slice(2);
if (!seat || !out) {
	console.error("usage: node scripts/autosettle/extract.ts <seat folder> <cases.json> [--since 8d]");
	process.exit(2);
}
const since = process.argv.includes("--since") ? process.argv[process.argv.indexOf("--since") + 1]! : "8d";
const abso = (...args: string[]): string =>
	execFileSync("abso", args, { cwd: seat, encoding: "utf8", maxBuffer: 1 << 28, shell: process.platform === "win32" });

const fileAt = (version: number, file: string): string[] | null => {
	try {
		return abso("show", `${version}:${file}`).split(/\r?\n/);
	} catch {
		return null;
	}
};

interface Settled {
	file: string;
	kept: "yours" | "theirs" | "both" | "rewrote";
	theirs: { agent: string; version: number };
	version: number;
	held?: string;
}
interface Change {
	agent?: string;
	author?: string;
	message?: string;
	settled: Settled[];
	versions?: { version: number; message: string }[];
}
const review = JSON.parse(abso("review", "--since", since, "--json")) as { changes: Change[] };
const messages = new Map<number, string>();
for (const c of review.changes) for (const v of c.versions ?? []) messages.set(v.version, v.message);
const messageOf = (v: number): string | undefined => {
	if (!messages.has(v)) {
		try {
			const head = abso("show", String(v)).split(/\r?\n/).slice(0, 6).join("\n");
			messages.set(v, /"([^"]*)"/.exec(head)?.[1] ?? head.split("\n")[0]!);
		} catch {
			return undefined;
		}
	}
	return messages.get(v);
};

interface Hunk {
	/** 0-based start and length on each side; a length of 0 is an insertion before (or deletion at) start. */
	aStart: number;
	aLen: number;
	bStart: number;
	bLen: number;
}

/** Line hunks from a to b, by git's diff. */
function hunks(a: string[], b: string[]): Hunk[] {
	const dir = mkdtempSync(join(tmpdir(), "autosettle-"));
	writeFileSync(join(dir, "a"), a.join("\n"));
	writeFileSync(join(dir, "b"), b.join("\n"));
	let text = "";
	try {
		text = execFileSync("git", ["diff", "--no-index", "-U0", "--no-color", join(dir, "a"), join(dir, "b")], {
			encoding: "utf8",
			maxBuffer: 1 << 28,
		});
	} catch (e) {
		// git diff --no-index exits 1 when the files differ.
		text = (e as { stdout?: string }).stdout ?? "";
	}
	rmSync(dir, { recursive: true, force: true });
	const list: Hunk[] = [];
	for (const m of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
		const aLen = m[2] === undefined ? 1 : Number(m[2]);
		const bLen = m[4] === undefined ? 1 : Number(m[4]);
		list.push({
			aStart: aLen === 0 ? Number(m[1]) : Number(m[1]) - 1,
			aLen,
			bStart: bLen === 0 ? Number(m[3]) : Number(m[3]) - 1,
			bLen,
		});
	}
	return list;
}

/** Where a line of b sits in a, given the hunks from a to b. */
const backTo = (hs: Hunk[], bAt: number) =>
	hs
		.filter((h) => h.bStart + h.bLen <= bAt && !(h.bLen === 0 && h.bStart === bAt))
		.reduce((n, h) => n - (h.bLen - h.aLen), bAt);

/**
 * The collisions a settle went through in one file: each of their hunks (before to theirs) that the
 * settler's own change (theirs to result) touches, with the lines on every side.
 */
function regions(before: string[], theirs: string[], result: string[]) {
	const d1 = hunks(before, theirs);
	const d2 = hunks(theirs, result);
	const touches = (h: Hunk, g: Hunk) => g.aStart <= h.bStart + h.bLen && h.bStart <= g.aStart + g.aLen;
	const found = [];
	for (const h of d1) {
		const near = d2.filter((g) => touches(h, g));
		if (near.length === 0) continue;
		const tStart = Math.min(h.bStart, ...near.map((g) => g.aStart));
		const tEnd = Math.max(h.bStart + h.bLen, ...near.map((g) => g.aStart + g.aLen));
		const rStart = d2
			.filter((g) => g.aStart + g.aLen <= tStart && !near.includes(g))
			.reduce((n, g) => n + (g.bLen - g.aLen), tStart);
		const rEnd = rStart + (tEnd - tStart) + near.reduce((n, g) => n + (g.bLen - g.aLen), 0);
		const bStart = backTo(d1, tStart);
		const bEnd = bStart + (tEnd - tStart) - (h.bLen - h.aLen);
		found.push({
			base: before.slice(bStart, bEnd),
			theirs: theirs.slice(tStart, tEnd),
			result: result.slice(rStart, rEnd),
			context: { before: theirs.slice(Math.max(0, tStart - 15), tStart), after: theirs.slice(tEnd, tEnd + 15) },
		});
	}
	return found;
}

const cases: { kept: string; yours: string[] | null }[] = [];
const groups = new Map<string, { change: Change; settled: Settled[] }>();
for (const c of review.changes)
	for (const s of c.settled) {
		const key = `${s.version} ${s.file}`;
		const g = groups.get(key) ?? { change: c, settled: [] };
		g.settled.push(s);
		groups.set(key, g);
	}
for (const { change: c, settled } of groups.values()) {
	const first = settled[0]!;
	const before = fileAt(first.theirs.version - 1, first.file);
	const theirs = fileAt(first.theirs.version, first.file);
	const result = fileAt(first.version, first.file);
	const found = before && theirs && result ? regions(before, theirs, result) : [];
	// Marker blocks the settler changed, in file order; a block where it kept theirs left no trace to find.
	const changed = settled.filter((s) => s.kept !== "theirs");
	settled.forEach((s, i) => {
		const notes: string[] = [];
		const r = s.kept === "theirs" ? undefined : found[changed.indexOf(s)];
		if (!before || !theirs || !result) notes.push("a version of the file couldn't be read");
		else if (s.kept === "theirs")
			notes.push("kept theirs: the region and yours aren't recoverable from versions alone");
		else if (!r) notes.push(`found ${found.length} changed regions for ${changed.length} settled blocks`);
		if (r && found.length !== changed.length)
			notes.push(`found ${found.length} changed regions for ${changed.length} settled blocks: the pairing may be off`);
		let yours: string[] | null = null;
		if (r && s.kept === "yours") yours = r.result;
		else if (r && s.kept === "both") {
			const tail = r.result.slice(r.result.length - r.theirs.length);
			if (tail.join("\n") === r.theirs.join("\n")) yours = r.result.slice(0, r.result.length - r.theirs.length);
			else notes.push("kept both, but the result doesn't end with theirs");
		} else if (r) notes.push(`yours isn't recoverable from the result when the agent kept ${s.kept}`);
		cases.push({
			id: `${s.version}-${s.file}#${i + 1}`,
			file: s.file,
			kind: "lines",
			settler: {
				agent: c.agent ?? c.author ?? "?",
				heldMessage: s.held,
				settleVersion: s.version,
				settleMessage: messageOf(s.version),
			},
			theirs: { agent: s.theirs.agent, version: s.theirs.version, message: messageOf(s.theirs.version) },
			base: r?.base ?? null,
			yours,
			theirsLines: r?.theirs ?? null,
			context: r?.context ?? { before: [], after: [] },
			result: r?.result ?? null,
			kept: s.kept,
			issue: null,
			notes: notes.join("; "),
		} as (typeof cases)[number]);
	});
}
writeFileSync(out, JSON.stringify(cases, null, "\t"));
const count = (k: string) => cases.filter((c) => c.kept === k).length;
console.log(
	`${cases.length} settled collisions: yours ${count("yours")}, theirs ${count("theirs")}, both ${count("both")}, rewrote ${count("rewrote")}; ${cases.filter((c) => c.yours !== null).length} with both sides recoverable.`,
);
