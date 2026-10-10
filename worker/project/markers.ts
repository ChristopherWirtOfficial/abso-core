// Collision markers (#11, round 1, ruled 2026-10-05): when a sync finds both
// sides changed the same lines differently, it writes the file diff3 style,
// so the collision can't pass for finished code. Helpers write, find and settle
// blocks, and read the blocks still in an agent's files (status, sync, publish).
//
//   <<<<<<< yours (unpublished)
//   ...the agent's lines...
//   ||||||| before (version 276)
//   ...the lines both started from...
//   =======
//   ...their lines...
//   >>>>>>> theirs: writer1, version 277 "Boiler gauge says what it multiplies"
//
// Settled means the block is gone. These helpers also say what an agent kept
// once it settled one.

import { type Atom, type AtomId, diffLines, type Graph, type Hunk, type View } from "../../src/engine/index.ts";
import type { AgentState, AgentStatus, Collision } from "./project-types.ts";

export const YOURS = "<<<<<<< yours (unpublished)";
const BEFORE = "||||||| before (version ";
export const SPLIT = "=======";
const THEIRS = ">>>>>>> theirs: ";
const THEIRS_LABEL = /^>>>>>>> theirs: (.+), version (\d+) "(.*)"$/;

/** One side of a block: who published theirs. */
export interface TheirSide {
	readonly agent: string;
	readonly version: number;
	readonly message: string;
}

/** A block in a file: 0-based indexes of its first and last marker lines, and each part. */
export interface Block extends TheirSide {
	readonly start: number;
	readonly end: number;
	readonly yours: readonly string[];
	readonly base: readonly string[];
	readonly theirs: readonly string[];
}

/** A collision a sync wrote markers for, kept until the agent publishes: what it says the agent kept. */
export interface MarkedRegion extends TheirSide {
	readonly file: string;
	readonly yours: readonly string[];
	readonly base: readonly string[];
	readonly theirs: readonly string[];
	/** The changes that collided (the draft's, then theirs): the edit that takes the markers out settles them. */
	readonly settles?: readonly string[];
}

export type Kept = "yours" | "theirs" | "both" | "rewrote";

/** A publish message as a marker label: its first line, at most 100 characters, with no double quotes. */
function label(message: string): string {
	const first = message.split("\n")[0]!.trim().replace(/"/g, "'");
	return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

export function markerBlock(
	yours: readonly string[],
	base: readonly string[],
	baseVersion: number,
	theirs: readonly string[],
	who: TheirSide,
): string[] {
	return [
		YOURS,
		...yours,
		`${BEFORE}${baseVersion})`,
		...base,
		SPLIT,
		...theirs,
		`${THEIRS}${who.agent}, version ${who.version} "${label(who.message)}"`,
	];
}

/** A line the engine writes as a marker (the split line alone is not one: `=======` is ordinary Markdown). */
export function isMarkerLine(line: string): boolean {
	return line === YOURS || (line.startsWith(BEFORE) && line.endsWith(")")) || THEIRS_LABEL.test(line);
}

/** The well-formed blocks in a file's lines, in order. */
export function blocksIn(lines: readonly string[]): Block[] {
	const out: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== YOURS) continue;
		let b = -1;
		let s = -1;
		let e = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j]!;
			if (l === YOURS) break;
			if (b < 0 && l.startsWith(BEFORE)) b = j;
			else if (b >= 0 && s < 0 && l === SPLIT) s = j;
			else if (s >= 0 && THEIRS_LABEL.test(l)) {
				e = j;
				break;
			}
		}
		if (e < 0) continue;
		const m = THEIRS_LABEL.exec(lines[e]!)!;
		out.push({
			start: i,
			end: e,
			yours: lines.slice(i + 1, b),
			base: lines.slice(b + 1, s),
			theirs: lines.slice(s + 1, e),
			agent: m[1]!,
			version: Number(m[2]),
			message: m[3]!,
		});
		i = e;
	}
	return out;
}

/** The lines with every block replaced by the side (or sides) kept. */
export function settleLines(
	lines: readonly string[],
	keep: "yours" | "theirs" | "both",
): { lines: string[]; blocks: number } {
	const blocks = blocksIn(lines);
	const out: string[] = [];
	let pos = 0;
	for (const b of blocks) {
		out.push(...lines.slice(pos, b.start));
		if (keep !== "theirs") out.push(...b.yours);
		if (keep !== "yours") out.push(...b.theirs);
		pos = b.end + 1;
	}
	out.push(...lines.slice(pos));
	return { lines: out, blocks: blocks.length };
}

/**
 * The edit from their text to the merged text that keeps their lines inside
 * each block as their lines: a plain diff would pair a `}` of theirs with a
 * `}` of yours, so their definition would read as partly the agent's, and the
 * duplicate check would miss it. Between blocks it is a plain diff. `blocks`
 * gives each block's place in the merged lines (at, length) and in theirs
 * (theirsAt, theirs: how many of their lines it holds).
 */
export function markedHunks(
	theirs: readonly string[],
	merged: readonly string[],
	blocks: readonly { at: number; length: number; theirsAt: number; theirs: number }[],
): Hunk[] {
	const out: Hunk[] = [];
	const push = (h: Hunk): void => {
		const last = out[out.length - 1];
		// Hunks that meet are one hunk, so no two edits touch the same gap.
		if (last && last.end === h.start)
			out[out.length - 1] = { start: last.start, end: h.end, lines: [...last.lines, ...h.lines] };
		else out.push(h);
	};
	let t = 0;
	let m = 0;
	for (const b of blocks) {
		for (const h of diffLines(theirs.slice(t, b.theirsAt), merged.slice(m, b.at)))
			push({ start: h.start + t, end: h.end + t, lines: h.lines });
		// The block is: its opening lines, their lines as they are, the closing marker.
		const head = b.length - b.theirs - 1;
		push({ start: b.theirsAt, end: b.theirsAt, lines: merged.slice(b.at, b.at + head) });
		push({ start: b.theirsAt + b.theirs, end: b.theirsAt + b.theirs, lines: [merged[b.at + b.length - 1]!] });
		t = b.theirsAt + b.theirs;
		m = b.at + b.length;
	}
	for (const h of diffLines(theirs.slice(t), merged.slice(m)))
		push({ start: h.start + t, end: h.end + t, lines: h.lines });
	return out;
}

/** A line's words, lowercased, without a checklist box: what "the same line, reworded" compares. */
function words(line: string): Set<string> {
	return new Set(
		line
			.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "")
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? [],
	);
}

/** Whether `b` reads as `a` reworded: at least half their words in common. */
function alike(a: string, b: string): boolean {
	if (a === b) return true;
	const x = words(a);
	const y = words(b);
	if (x.size === 0 || y.size === 0) return false;
	let both = 0;
	for (const w of x) if (y.has(w)) both++;
	return both / (x.size + y.size - both) >= 0.5;
}

/**
 * Lines both sides still had that the settled file has lost (#37): neither side deleted them, yet neither side's version, nor the base's,
 * nor anything reading like a rewording of one, is left. When both sides
 * changed line for line, each position is one line in three versions;
 * otherwise only lines both sides kept word for word count. Answers each
 * lost line as one side gave it.
 */
export function lostLines(lines: readonly string[], region: MarkedRegion): string[] {
	const solid = (l: string | undefined): l is string => l !== undefined && /[A-Za-z0-9]/.test(l);
	const groups: string[][] =
		region.yours.length === region.theirs.length
			? region.yours.map((y, i) => [
					y,
					region.theirs[i]!,
					...(region.base.length === region.yours.length ? [region.base[i]!] : []),
				])
			: region.yours.filter((l) => region.theirs.includes(l)).map((l) => [l]);
	const now = lines.filter((l) => solid(l));
	const out: string[] = [];
	for (const g of groups) {
		const versions = g.filter(solid);
		if (versions.length === 0) continue;
		if (versions.some((v) => now.some((l) => alike(v, l)))) continue;
		out.push(versions[0]!);
	}
	return out;
}

/**
 * What a settled region kept, judged from the file as it is now, by each
 * side's own changes (#37): the lines it added, and
 * the base lines only it removed. A side's block also holds lines it left as
 * they were, and an edit to one of those must not hide that its change was
 * kept. Lines both sides added alike, and lines with no letters or digits
 * (`}`, blank), say nothing about whose change survived.
 */
export function keptOf(lines: readonly string[], region: MarkedRegion): Kept {
	const now = new Set(lines);
	const base = new Set(region.base);
	const solid = (l: string) => /[A-Za-z0-9]/.test(l);
	const yours = new Set(region.yours);
	const theirs = new Set(region.theirs);
	// Whether each of a side's changes is in the file: all of them, none, some, or it made none of its own.
	const score = (
		mine: Set<string>,
		other: Set<string>,
		side: readonly string[],
	): "all" | "none" | "some" | "nothing" => {
		const checks = [
			...side.filter((l) => solid(l) && !base.has(l) && !other.has(l)).map((l) => now.has(l)),
			...region.base.filter((l) => solid(l) && !mine.has(l) && other.has(l)).map((l) => !now.has(l)),
		];
		if (checks.length === 0) return "nothing";
		if (checks.every(Boolean)) return "all";
		return checks.some(Boolean) ? "some" : "none";
	};
	const y = score(yours, theirs, region.yours);
	const t = score(theirs, yours, region.theirs);
	if (y === "some" || t === "some") return "rewrote";
	if (y === "all" && t === "all") return "both";
	if (y === "all") return "yours";
	if (t === "all") return "theirs";
	// One side made no change of its own and the other's is gone: what's left is the first side's.
	if (y === "none" && t === "nothing") return "theirs";
	if (t === "none" && y === "nothing") return "yours";
	return y === "nothing" && t === "nothing" ? "both" : "rewrote";
}

/** What the marker reads need from a project. */
export interface MarkerHost {
	readonly graph: Graph;
	agentView(agent: AgentState): View;
	draft(agent: AgentState): AtomId[];
	draftFiles(agent: AgentState): Set<string>;
}

/** Files where a sync wrote the agent collision markers in its current space (#11). */
export function markedFiles(agent: AgentState): string[] {
	return [...new Set(agent.marked.filter((r) => r.space === agent.space).map((r) => r.file))].toSorted();
}

export function blockCollision(file: string, b: Block): Collision {
	const lines: [number, number] = [b.start + 1, b.end + 1];
	const text = (ls: readonly string[]) => (ls.length > 0 ? `${ls.join("\n")}\n` : "");
	return {
		kind: "lines",
		marked: true,
		file,
		yours: { lines, text: text(b.yours) },
		theirs: { lines: [...lines], text: text(b.theirs), agent: b.agent, message: b.message, version: b.version },
	};
}

/** The blocks of markers still in the agent's files, as collisions (#11): listed by sync and status. */
export function markedCollisions(host: MarkerHost, agent: AgentState): Collision[] {
	const files = markedFiles(agent);
	// No marked files, no view to build: most agents have none.
	if (files.length === 0) return [];
	const view = host.agentView(agent);
	const out: Collision[] = [];
	for (const file of files) {
		if (!view.hasFile(file)) continue;
		for (const b of blocksIn(view.lines(file).map((l) => l.text))) out.push(blockCollision(file, b));
	}
	return out;
}

export function openCollisions(host: MarkerHost, agent: AgentState): { collisions?: AgentStatus["collisions"] } {
	const open = markedCollisions(host, agent).map((c) => ({
		file: c.file,
		lines: c.yours.lines,
		theirs: { agent: c.theirs.agent, version: c.theirs.version, message: c.theirs.message },
	}));
	return open.length > 0 ? { collisions: open } : {};
}

/** The collided changes behind each block whose marker lines `atom` deletes (#11). */
export function markersSettled(host: MarkerHost, agent: AgentState, view: View, atom: Atom): AtomId[] {
	if (agent.marked.length === 0) return [];
	const out = new Set<AtomId>();
	const blocksBy = new Map<string, Block[]>();
	for (const id of atom.deletes) {
		const info = host.graph.line(id);
		if (!info || !isMarkerLine(info.text)) continue;
		const file = view.fileOf(id);
		const lines = view.lines(file);
		if (!blocksBy.has(file)) blocksBy.set(file, blocksIn(lines.map((l) => l.text)));
		const at = lines.findIndex((l) => l.id === id);
		const b = blocksBy.get(file)!.find((x) => at >= x.start && at <= x.end);
		if (!b) continue;
		const r = agent.marked.find(
			(m) => m.space === agent.space && m.file === file && m.agent === b.agent && m.version === b.version,
		);
		for (const s of r?.settles ?? []) out.add(s);
	}
	// Only changes still in the view can be named: the draft's own side was replaced when the sync wrote the markers.
	return [...out].filter((id) => view.set.has(id));
}

/**
 * Marker lines the agent's draft adds (#11), as collisions: each
 * well-formed block, and any marker line left outside one. Only the labeled
 * lines the engine writes count, so a document that shows markers can be
 * published.
 */
export function markerCollisions(host: MarkerHost, agent: AgentState): Collision[] {
	const mine = new Set(host.draft(agent));
	const view = host.agentView(agent);
	const out: Collision[] = [];
	for (const file of [...host.draftFiles(agent)].toSorted()) {
		if (!view.hasFile(file)) continue;
		const lines = view.lines(file);
		const added = lines.map((l, i) => (mine.has(l.atom) && isMarkerLine(l.text) ? i : -1)).filter((i) => i >= 0);
		if (added.length === 0) continue;
		const blocks = blocksIn(lines.map((l) => l.text));
		for (const b of blocks) out.push(blockCollision(file, b));
		for (const i of added) {
			if (blocks.some((b) => i >= b.start && i <= b.end)) continue;
			const at: [number, number] = [i + 1, i + 1];
			out.push({
				kind: "lines",
				marked: true,
				file,
				yours: { lines: at, text: `${lines[i]!.text}\n` },
				theirs: { lines: [...at], text: "", agent: "", message: "a marker line left from a collision", version: 0 },
			});
		}
	}
	return out;
}
