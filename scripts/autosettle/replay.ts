// Recover each past hold's lines from a project's raw log (#19): the held agent's own lines survive in its draft
// entries even after it kept theirs or edited by hand, which no version shows.
//
//   node --max-old-space-size=8192 scripts/autosettle/replay.ts <log.ndjson> <cases.json> <out.json>
//
// <log.ndjson> is GET /p/<project>/export (one raw log entry per line; owner-only). <cases.json> comes from
// extract.ts, which says which settles to look for and what was kept. For each settle, the engine rebuilds three
// files from the log: the held agent's at its refused push (its base plus its draft), its base, and theirs' version.
// git merge-file --diff3 cuts them into blocks as a pull would, and the blocks pair with the settle's in order.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph } from "../../src/engine/graph.ts";
import type { Atom } from "../../src/engine/types.ts";
import { View } from "../../src/engine/view.ts";

type Entry = {
	type: string;
	agent?: string;
	space?: string | null;
	version?: number;
	time?: number;
	atom?: Atom;
	tie?: Atom;
	atoms?: string[];
	changes?: string[];
	collisions?: { file: string }[];
};
interface Case {
	id: string;
	file: string;
	settler: { agent: string; heldMessage?: string; settleVersion: number; settleMessage?: string };
	theirs: { agent: string; version: number; message?: string };
	kept: string;
	[k: string]: unknown;
}

const [logPath, casesPath, out] = process.argv.slice(2);
if (!logPath || !casesPath || !out) {
	console.error(
		"usage: node --max-old-space-size=8192 scripts/autosettle/replay.ts <log.ndjson> <cases.json> <out.json>",
	);
	process.exit(2);
}
const entries: Entry[] = readFileSync(logPath, "utf8")
	.split("\n")
	.filter((l) => l.trim() !== "")
	.map((l) => JSON.parse(l) as Entry);
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];

// Every atom into one graph, and shared's set after each version.
const graph = new Graph();
const added = (a: Atom | undefined) => {
	if (a && !graph.has(a.id)) graph.add(a);
};
const sharedAt = new Map<number, Set<string>>();
const versionAt = new Map<number, number>();
let shared = new Set<string>();
entries.forEach((e, i) => {
	added(e.atom);
	added(e.tie);
	if (e.type === "init" && e.atom) {
		shared.add(e.atom.id);
		sharedAt.set(0, new Set(shared));
	}
	const intoShared = (e.type === "publish" && !e.space) || e.type === "land";
	if (intoShared && typeof e.version === "number") {
		shared = new Set(shared);
		for (const id of e.changes ?? []) shared.add(id);
		if (e.tie) shared.add(e.tie.id);
		sharedAt.set(e.version, shared);
		versionAt.set(e.version, i);
	}
});
const textOf = (set: Set<string>, file: string): string[] => {
	const view = new View(graph, set);
	return view.hasFile(file) ? view.lines(file).map((l) => l.text) : [];
};

/** The agent's base version and its unpublished draft atoms just before log index `end`. */
function draftBefore(agent: string, end: number): { base: number; draft: string[] } {
	let base = 0;
	let start = 0;
	for (let i = end - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.agent !== agent) continue;
		if (base === 0 && (e.type === "sync" || e.type === "join") && typeof e.version === "number") base = e.version;
		if ((e.type === "publish" && !e.space) || e.type === "land") {
			if (base === 0 && typeof e.version === "number") base = e.version;
			start = i + 1;
			break;
		}
	}
	const draft: string[] = [];
	for (const e of entries.slice(start, end)) {
		if (e.agent !== agent) continue;
		if (e.type === "draft" && e.atom) draft.push(e.atom.id);
		if (e.type === "discard")
			for (const id of e.atoms ?? []) draft.splice(draft.indexOf(id), draft.includes(id) ? 1 : 0);
	}
	return { base, draft };
}

interface Block {
	yours: string[];
	base: string[];
	theirs: string[];
	/** Where the block starts in theirs. */
	at: number;
}
/** git's three-way merge of the files, as marker blocks with each side's lines. */
function blocks(yours: string[], base: string[], theirs: string[]): Block[] {
	const dir = mkdtempSync(join(tmpdir(), "autosettle-"));
	const path = (n: string) => join(dir, n);
	writeFileSync(path("yours"), `${yours.join("\n")}\n`);
	writeFileSync(path("base"), `${base.join("\n")}\n`);
	writeFileSync(path("theirs"), `${theirs.join("\n")}\n`);
	let merged = "";
	try {
		merged = execFileSync("git", ["merge-file", "-p", "--diff3", path("yours"), path("base"), path("theirs")], {
			encoding: "utf8",
			maxBuffer: 1 << 28,
		});
	} catch (e) {
		// git merge-file exits with the number of conflicts.
		merged = (e as { stdout?: string }).stdout ?? "";
	}
	rmSync(dir, { recursive: true, force: true });
	const found: Block[] = [];
	let side: "out" | "yours" | "base" | "theirs" = "out";
	let cur: Block = { yours: [], base: [], theirs: [], at: 0 };
	let theirsLine = 0;
	for (const line of merged.split("\n")) {
		if (line.startsWith("<<<<<<< ")) {
			side = "yours";
			cur = { yours: [], base: [], theirs: [], at: theirsLine };
		} else if (side === "yours" && line.startsWith("||||||| ")) side = "base";
		else if (side === "base" && line === "=======") side = "theirs";
		else if (side === "theirs" && line.startsWith(">>>>>>> ")) {
			found.push(cur);
			side = "out";
		} else if (side === "out") theirsLine++;
		else {
			cur[side].push(line);
			if (side === "theirs") theirsLine++;
		}
	}
	return found;
}

const results: unknown[] = [];
const byGroup = new Map<string, Case[]>();
for (const c of cases) {
	const key = `${c.settler.settleVersion} ${c.file}`;
	byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
}
for (const group of byGroup.values()) {
	const c0 = group[0]!;
	const settleAt = versionAt.get(c0.settler.settleVersion);
	const theirSet = sharedAt.get(c0.theirs.version);
	if (settleAt === undefined || !theirSet) {
		for (const c of group) results.push({ ...c, yours: null, notes: "the settle or theirs isn't in this log" });
		continue;
	}
	const notes: string[] = [];
	let refusedAt = -1;
	for (let i = settleAt - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "refused" && e.agent === c0.settler.agent && (e.collisions ?? []).some((x) => x.file === c0.file)) {
			refusedAt = i;
			break;
		}
	}
	// No refusal on record (older holds): the draft just before the agent's first pull past theirs.
	let end = refusedAt;
	if (end < 0) {
		notes.push("no refused push on record; used the draft before the agent pulled theirs");
		const theirsAt = versionAt.get(c0.theirs.version)!;
		end = settleAt;
		for (let i = theirsAt + 1; i < settleAt; i++) {
			const e = entries[i]!;
			if (e.agent === c0.settler.agent && e.type === "sync" && (e.version ?? 0) >= c0.theirs.version) {
				end = i;
				break;
			}
		}
	}
	const { base, draft } = draftBefore(c0.settler.agent, end);
	const baseSet = sharedAt.get(base);
	if (!baseSet) {
		for (const c of group) results.push({ ...c, yours: null, notes: `no shared version ${base} in this log` });
		continue;
	}
	const yoursText = textOf(new Set([...baseSet, ...draft]), c0.file);
	const baseText = textOf(baseSet, c0.file);
	const theirText = textOf(theirSet, c0.file);
	const found = blocks(yoursText, baseText, theirText);
	if (found.length !== group.length) notes.push(`git found ${found.length} blocks for ${group.length} settled`);
	group.forEach((c, i) => {
		const b = found.length === group.length ? found[i] : undefined;
		results.push({
			...c,
			base: b?.base ?? null,
			yours: b?.yours ?? null,
			theirsLines: b?.theirs ?? null,
			context: b
				? {
						before: theirText.slice(Math.max(0, b.at - 15), b.at),
						after: theirText.slice(b.at + b.theirs.length, b.at + b.theirs.length + 15),
					}
				: { before: [], after: [] },
			notes: [...notes, ...(b ? [] : ["blocks don't pair one to one, so none is used"])].join("; "),
			recoveredBy: "replay",
		});
	});
}
writeFileSync(out, JSON.stringify(results, null, "\t"));
const ok = results.filter((r) => (r as { yours: unknown }).yours !== null).length;
console.log(`${results.length} settled blocks; ${ok} with both sides recovered from the log.`);
