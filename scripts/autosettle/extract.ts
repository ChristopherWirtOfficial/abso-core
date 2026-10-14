// Build scored test cases from a project's past settles (#19), read through the
// abso client in a seat folder joined to that project (a reader seat is enough).
//
//   node scripts/autosettle/extract.ts <seat folder> <cases.json> [--since 8d]
//
// Each settled collision gives: the file before theirs (their version - 1, the
// best guess at what both started from), theirs, and the settle's result.
// The held agent's own lines are only recoverable from the result when it kept
// yours or both; otherwise "yours" is null and score.ts skips the case.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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
const review = JSON.parse(abso("review", "--since", since, "--json")) as {
	changes: {
		agent?: string;
		author?: string;
		message?: string;
		settled: Settled[];
		versions?: { version: number; message: string }[];
	}[];
};
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

/** The span where `a` and `b` differ, by common prefix and suffix. */
function hunk(a: string[], b: string[]): { start: number; aEnd: number; bEnd: number } {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let tail = 0;
	while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail])
		tail++;
	return { start, aEnd: a.length - tail, bEnd: b.length - tail };
}

/** The lines of `r` between the context above and below a hunk of `t`, found by a few anchor lines. */
function regionIn(r: string[], t: string[], start: number, end: number): string[] | null {
	const above = t.slice(Math.max(0, start - 3), start);
	const below = t.slice(end, end + 3);
	const find = (needle: string[], from: number) => {
		if (needle.length === 0) return -1;
		for (let i = from; i + needle.length <= r.length; i++) if (needle.every((l, j) => r[i + j] === l)) return i;
		return -2;
	};
	const a = find(above, 0);
	const from = above.length === 0 ? 0 : a < 0 ? -1 : a + above.length;
	if (from < 0) return null;
	const b = find(below, from);
	const to = below.length === 0 ? r.length : b < 0 ? -1 : b;
	return to < 0 ? null : r.slice(from, to);
}

const cases = [];
for (const c of review.changes) {
	for (const s of c.settled) {
		const before = fileAt(s.theirs.version - 1, s.file);
		const theirs = fileAt(s.theirs.version, s.file);
		const result = fileAt(s.version, s.file);
		const notes: string[] = [];
		let base: string[] | null = null;
		let theirsLines: string[] | null = null;
		let region: string[] | null = null;
		let context = { before: [] as string[], after: [] as string[] };
		if (before && theirs && result) {
			const h = hunk(before, theirs);
			base = before.slice(h.start, h.aEnd);
			theirsLines = theirs.slice(h.start, h.bEnd);
			context = { before: theirs.slice(Math.max(0, h.start - 15), h.start), after: theirs.slice(h.bEnd, h.bEnd + 15) };
			region = regionIn(result, theirs, h.start, h.bEnd);
			if (region === null) notes.push("couldn't find the region in the settled file");
			if (theirsLines.length > 80) notes.push(`their change spans ${theirsLines.length} lines`);
		} else notes.push("a version of the file couldn't be read");
		let yours: string[] | null = null;
		if (region && s.kept === "yours") yours = region;
		else if (region && theirsLines && s.kept === "both") yours = region.slice(0, region.length - theirsLines.length);
		else notes.push(`yours isn't recoverable from the result when the agent kept ${s.kept}`);
		cases.push({
			id: `${s.version}-${s.file}`,
			file: s.file,
			kind: "lines",
			settler: {
				agent: c.agent ?? c.author ?? "?",
				heldMessage: s.held,
				settleVersion: s.version,
				settleMessage: messageOf(s.version),
			},
			theirs: { agent: s.theirs.agent, version: s.theirs.version, message: messageOf(s.theirs.version) },
			base,
			yours,
			theirsLines,
			context,
			result: region,
			kept: s.kept,
			issue: null,
			notes: notes.join("; "),
		});
	}
}
writeFileSync(out, JSON.stringify(cases, null, "\t"));
const count = (k: string) => cases.filter((c) => c.kept === k).length;
console.log(
	`${cases.length} settled collisions: yours ${count("yours")}, theirs ${count("theirs")}, both ${count("both")}, rewrote ${count("rewrote")}; ${cases.filter((c) => c.yours !== null).length} with both sides recoverable.`,
);
