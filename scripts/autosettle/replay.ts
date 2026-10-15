// Recover each past hold's lines from a project's raw log (#19): the held agent's own lines survive in its draft
// entries even after it kept theirs or edited by hand, which no version shows.
//
//   node scripts/autosettle/replay.ts <log.ndjson> <cases.json> <seat folder> <out.json>
//
// <log.ndjson> is GET /p/<project>/export (one raw log entry per line; owner-only). <cases.json> comes from
// extract.ts, which says which settles to look for and what was kept. The seat folder reads theirs' file text
// for positions and context. For each settle: the held agent's draft edits between its last push and the
// refused push, the edits of theirs' push, and the groups of them that wrote the same lines (abso's own test
// for a collision), in file order, paired with the settle's blocks in order.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface InsertRun {
	file: string;
	parent: string;
	lines: string[];
}
interface Atom {
	id: string;
	seq: number;
	author: string;
	time: number;
	inserts: InsertRun[];
	deletes: string[];
	writes: string[];
}
type Entry = {
	type: string;
	agent?: string;
	time?: number;
	atom?: Atom;
	tie?: Atom;
	version?: number;
	space?: string;
} & Record<string, unknown>;
interface Case {
	id: string;
	file: string;
	settler: { agent: string; heldMessage?: string; settleVersion: number; settleMessage?: string };
	theirs: { agent: string; version: number; message?: string };
	kept: string;
	[k: string]: unknown;
}

const [logPath, casesPath, seat, out] = process.argv.slice(2);
if (!logPath || !casesPath || !seat || !out) {
	console.error("usage: node scripts/autosettle/replay.ts <log.ndjson> <cases.json> <seat folder> <out.json>");
	process.exit(2);
}
const entries: Entry[] = readFileSync(logPath, "utf8")
	.split("\n")
	.filter((l) => l.trim() !== "")
	.map((l) => JSON.parse(l) as Entry);
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
const abso = (...args: string[]) =>
	execFileSync("abso", args, { cwd: seat, encoding: "utf8", maxBuffer: 1 << 28, shell: process.platform === "win32" });

// Every line any atom inserted: its text and file.
const lineText = new Map<string, { text: string; file: string }>();
const atoms = new Map<string, Atom>();
for (const e of entries)
	for (const a of [e.atom, e.tie]) {
		if (!a?.inserts) continue;
		atoms.set(a.id, a);
		let k = 0;
		for (const run of a.inserts) for (const text of run.lines) lineText.set(`${a.id}.${k++}`, { text, file: run.file });
	}
const insertedIds = (a: Atom, file: string) => {
	const ids: string[] = [];
	let k = 0;
	for (const run of a.inserts)
		for (const _ of run.lines) {
			if (run.file === file) ids.push(`${a.id}.${k}`);
			k++;
		}
	return ids;
};
const MARKER = /^(<<<<<<< yours|\|\|\|\|\|\|\| before|=======$|>>>>>>> theirs:)/;

/** The published shared version's index in the log, and the agent's draft atoms before an index since its last push. */
const publishAt = new Map<number, number>();
entries.forEach((e, i) => {
	if ((e.type === "publish" || e.type === "land") && e.space === undefined && typeof e.version === "number")
		publishAt.set(e.version, i);
});
function draftBefore(agent: string, end: number): Atom[] {
	let start = 0;
	for (let i = end - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.agent === agent && (e.type === "publish" || e.type === "land")) {
			start = i + 1;
			break;
		}
	}
	return entries
		.slice(start, end)
		.filter((e) => e.type === "draft" && e.agent === agent && e.atom)
		.map((e) => e.atom!);
}

/** Atoms touching `file`, grouped into collisions: groups linked by a written key or by one editing another's lines. */
function collisions(mine: Atom[], theirs: Atom[], file: string) {
	const touches = (a: Atom) =>
		a.inserts.some((r) => r.file === file) || a.deletes.some((d) => lineText.get(d)?.file === file);
	const all = [
		...mine.filter(touches).map((a) => ({ a, side: "yours" as const })),
		...theirs.filter(touches).map((a) => ({ a, side: "theirs" as const })),
	];
	const parent = all.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
	const keyOwner = new Map<string, number>();
	all.forEach(({ a }, i) => {
		const keys = [...a.writes, ...a.deletes.map((d) => `L:${d}`)];
		for (const own of insertedIds(a, file)) keys.push(`own:${own}`);
		for (const k of keys) {
			const key = k.startsWith("own:") ? `L:${k.slice(4)}` : k;
			const j = keyOwner.get(key);
			if (j === undefined) keyOwner.set(key, i);
			else parent[find(i)] = find(j);
		}
	});
	const groups = new Map<number, typeof all>();
	all.forEach((x, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), x]));
	return [...groups.values()].filter((g) => g.some((x) => x.side === "yours") && g.some((x) => x.side === "theirs"));
}

/** The lines a side's atoms in a group leave standing, in order, without marker lines. */
function standing(group: { a: Atom; side: string }[], side: string, file: string): string[] {
	const atomsOf = group.filter((x) => x.side === side).map((x) => x.a);
	const gone = new Set(atomsOf.flatMap((a) => a.deletes));
	return atomsOf
		.sort((x, y) => x.seq - y.seq)
		.flatMap((a) => insertedIds(a, file))
		.filter((id) => !gone.has(id))
		.map((id) => lineText.get(id)!.text)
		.filter((t) => !MARKER.test(t));
}

const results: unknown[] = [];
const byGroup = new Map<string, Case[]>();
for (const c of cases) {
	const key = `${c.settler.settleVersion} ${c.file}`;
	byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
}
for (const group of byGroup.values()) {
	const c0 = group[0]!;
	const settleAt = publishAt.get(c0.settler.settleVersion);
	const theirsAt = publishAt.get(c0.theirs.version);
	const notes: string[] = [];
	if (settleAt === undefined || theirsAt === undefined) {
		for (const c of group) results.push({ ...c, yours: null, notes: "the settle or theirs isn't in this log" });
		continue;
	}
	// The held push: the settler's newest refusal naming the file before its settle.
	let refusedAt = -1;
	for (let i = settleAt - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "refused" && e.agent === c0.settler.agent) {
			const files = ((e.collisions as { file: string }[] | undefined) ?? []).map((x) => x.file);
			if (files.includes(c0.file)) {
				refusedAt = i;
				break;
			}
		}
	}
	if (refusedAt < 0) notes.push("no refused push found; used the draft just before the settle");
	const mine = draftBefore(c0.settler.agent, refusedAt >= 0 ? refusedAt : settleAt);
	const theirPublish = entries[theirsAt]!;
	const theirIds = (theirPublish.changes as string[] | undefined) ?? [];
	const theirs = theirIds.map((id) => atoms.get(id)).filter((a): a is Atom => a !== undefined);
	const found = collisions(mine, theirs, c0.file);
	// File order, by where theirs' first standing line sits in theirs' version.
	let theirFile: string[] = [];
	try {
		theirFile = abso("show", `${c0.theirs.version}:${c0.file}`).split(/\r?\n/);
	} catch {
		notes.push("couldn't read theirs' file");
	}
	const placed = found
		.map((g) => {
			const t = standing(g, "theirs", c0.file);
			const at = t.length > 0 ? theirFile.indexOf(t[0]!) : -1;
			return { g, at, yours: standing(g, "yours", c0.file), theirs: t };
		})
		.sort((x, y) => x.at - y.at);
	if (placed.length !== group.length)
		notes.push(`found ${placed.length} collisions for ${group.length} settled blocks`);
	group.forEach((c, i) => {
		const p = placed[i];
		const base = p
			? [...new Set(p.g.flatMap((x) => x.a.deletes))]
					.filter((d) => !p.g.some((x) => insertedIds(x.a, c.file).includes(d)))
					.map((d) => lineText.get(d)?.text)
					.filter((t): t is string => t !== undefined && !MARKER.test(t))
			: null;
		results.push({
			...c,
			base,
			yours: p ? p.yours : null,
			theirsLines: p ? p.theirs : null,
			context:
				p && p.at >= 0
					? {
							before: theirFile.slice(Math.max(0, p.at - 15), p.at),
							after: theirFile.slice(p.at + p.theirs.length, p.at + p.theirs.length + 15),
						}
					: { before: [], after: [] },
			notes: [...notes, ...(p ? [] : ["no collision paired with this block"])].join("; "),
			recoveredBy: "replay",
		});
	});
}
writeFileSync(out, JSON.stringify(results, null, "\t"));
const ok = results.filter((r) => (r as { yours: unknown }).yours !== null).length;
console.log(`${results.length} settled blocks; ${ok} with both sides recovered from the log.`);
