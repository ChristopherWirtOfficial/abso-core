// A line's earlier changes, for why (abso-core issue 20). A line's id names
// the change that wrote it, so a line that was rewritten (reformatted,
// renamed, edited) is a new line, and the one it replaced is a deleted line
// in the same file. The file's full sequence keeps deleted lines where they
// were, so the lines a change deleted and the lines it wrote sit together:
// that's one hunk, and the line it replaced is the one it pairs with there.
// Following those pairs back gives the line's changes, newest first. A
// change that only touched formatting (whitespace, line wrapping, quotes,
// trailing commas and semicolons, parentheses around one arrow parameter)
// is marked, so why can skip past it to the change that said what the line
// does.

import type { Atom, AtomId, Graph, LineId, ReadView, SeqLine } from "../../src/engine/index.ts";

/** One change in a line's past, newest first. */
export interface TrailStep {
	/** The change that wrote the line. */
	readonly atom: AtomId;
	/** The line it wrote, and its text then. */
	readonly line: LineId;
	readonly text: string;
	/** It only changed formatting from the line it replaced. */
	readonly formatting: boolean;
	/** The line it replaced, when it replaced one. */
	readonly replaced?: LineId;
}

/** At most this many steps back. */
export const TRAIL_MAX = 50;

/**
 * Text with formatting taken out, for comparing two versions of the same
 * code: no whitespace, one kind of quote, no trailing commas before a
 * closing bracket, no semicolons at line ends (or before a comment there), and no parentheses around a
 * lone arrow parameter. Lines are normalized then joined, so a statement
 * wrapped onto three lines matches it on one.
 */
export function normalize(lines: readonly string[]): string {
	return lines
		.map((l) => l.replace(/;\s*(\/\/.*)?$/, "$1"))
		.join("")
		.replace(/\s+/g, "")
		.replace(/['`]/g, '"')
		.replace(/,(?=[)\]}]|$)/g, "")
		.replace(/\(([A-Za-z_$][\w$]*)\)=>/g, "$1=>");
}

/** Whether two runs of lines are the same code, formatted differently (or not at all). */
export function sameCode(before: readonly string[], after: readonly string[]): boolean {
	return normalize(before) === normalize(after);
}

/** Similarity of two strings, 0 to 1: shared character pairs (Dice). */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const pairs = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const p = a.slice(i, i + 2);
		pairs.set(p, (pairs.get(p) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const p = b.slice(i, i + 2);
		const n = pairs.get(p) ?? 0;
		if (n > 0) {
			shared++;
			pairs.set(p, n - 1);
		}
	}
	return (2 * shared) / (a.length + b.length - 2);
}

/** Below this, a rewritten line isn't taken for the one it replaced: it was new. */
const SIMILAR = 0.4;

/**
 * For a run that's the same code reformatted: which old line each new line
 * came from, by where its characters fall in the joined, normalized text
 * (the old line it overlaps most).
 */
function byCharacters(before: readonly string[], after: readonly string[], at: number): number | undefined {
	const spans = (lines: readonly string[]) => {
		let from = 0;
		return lines.map((l) => {
			const n = normalize([l]).length;
			const span = [from, from + n] as const;
			from += n;
			return span;
		});
	};
	const [from, to] = spans(after)[at]!;
	let best: number | undefined;
	let most = 0;
	for (const [i, [a, b]] of spans(before).entries()) {
		const overlap = Math.min(to, b) - Math.max(from, a);
		if (overlap > most) [best, most] = [i, overlap];
	}
	return best;
}

/** Longest common subsequence of two lists of keys: matched index pairs, in order. */
function common(a: readonly string[], b: readonly string[]): [number, number][] {
	const n = a.length;
	const m = b.length;
	// Hunks are small; a full table is fine, but cap it so a whole-file rewrite stays cheap.
	if (n * m > 4_000_000) return [];
	const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
	const out: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push([i, j]);
			i++;
			j++;
		} else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
		else j++;
	}
	return out;
}

/**
 * In one hunk, the old line a new one replaced, and whether that was only
 * formatting. Lines whose normalized text matches pair first; between those,
 * a run that's the same code rewrapped pairs by its characters; anything
 * else pairs with the most similar old line, if one is similar enough.
 */
export function pairIn(
	before: readonly string[],
	after: readonly string[],
	at: number,
): { index: number; formatting: boolean } | undefined {
	if (before.length === 0) return undefined;
	if (sameCode(before, after)) {
		const index = byCharacters(before, after, at);
		return index === undefined ? undefined : { index, formatting: true };
	}
	const keys = (lines: readonly string[]) => lines.map((l) => normalize([l]));
	const a = keys(before);
	const b = keys(after);
	const anchors = common(a, b);
	const hit = anchors.find(([, j]) => j === at);
	if (hit && a[hit[0]] !== "") return { index: hit[0], formatting: true };
	// The gap between anchors that holds the new line.
	let [i0, j0] = [0, 0];
	let [i1, j1] = [before.length, after.length];
	for (const [i, j] of anchors) {
		if (j < at) [i0, j0] = [i + 1, j + 1];
		else if (j > at) {
			[i1, j1] = [i, j];
			break;
		}
	}
	const gapBefore = before.slice(i0, i1);
	const gapAfter = after.slice(j0, j1);
	if (gapBefore.length === 0) return undefined;
	if (sameCode(gapBefore, gapAfter)) {
		const index = byCharacters(gapBefore, gapAfter, at - j0);
		return index === undefined ? undefined : { index: i0 + index, formatting: true };
	}
	let best: number | undefined;
	let most = SIMILAR;
	for (let i = i0; i < i1; i++) {
		const s = similarity(a[i]!, b[at]!);
		if (s >= most) [best, most] = [i, s];
	}
	return best === undefined ? undefined : { index: best, formatting: false };
}

/**
 * The line's changes, newest first: the change that wrote it, then the one
 * that wrote the line it replaced, and so on back to a change that wrote it
 * new. At most `max` steps; `more` says the trail went on.
 */
export function trail(
	graph: Graph,
	view: ReadView,
	file: string,
	line: LineId,
	max = TRAIL_MAX,
): { steps: TrailStep[]; more: boolean } {
	const seq = view.sequence(file);
	const index = new Map<LineId, number>();
	for (const [i, s] of seq.entries()) index.set(s.id, i);
	const steps: TrailStep[] = [];
	let current: LineId | undefined = line;
	while (current !== undefined && steps.length < max) {
		const at = index.get(current);
		if (at === undefined) break;
		const atom = graph.atom(seq[at]!.atom);
		const hunk = hunkOf(graph, seq, at, atom);
		const pair = pairIn(
			hunk.before.map((i) => seq[i]!.text),
			hunk.after.map((i) => seq[i]!.text),
			hunk.after.indexOf(at),
		);
		const replaced = pair ? seq[hunk.before[pair.index]!]!.id : undefined;
		steps.push({
			atom: atom.id,
			line: current,
			text: seq[at]!.text,
			formatting: pair?.formatting ?? false,
			...(replaced !== undefined ? { replaced } : {}),
		});
		current = replaced;
	}
	return { steps, more: current !== undefined };
}

/**
 * The hunk a change made around one of its lines, as indexes into the
 * sequence in file order: the lines it deleted there and the lines it wrote.
 * Lines nobody could see when it was made (written later, or already
 * deleted) are passed over; a line it left alone ends the hunk.
 */
function hunkOf(graph: Graph, seq: readonly SeqLine[], at: number, atom: Atom): { before: number[]; after: number[] } {
	const seqOf = (id: AtomId) => graph.atom(id).seq;
	const role = (s: SeqLine): "wrote" | "deleted" | "unseen" | "kept" => {
		if (s.atom === atom.id) return "wrote";
		if (seqOf(s.atom) > atom.seq) return "unseen";
		if (s.deletedBy.some((d) => d !== atom.id && seqOf(d) < atom.seq)) return "unseen";
		return s.deletedBy.includes(atom.id) ? "deleted" : "kept";
	};
	let first = at;
	while (first > 0 && role(seq[first - 1]!) !== "kept") first--;
	let last = at;
	while (last < seq.length - 1 && role(seq[last + 1]!) !== "kept") last++;
	const before: number[] = [];
	const after: number[] = [];
	for (let i = first; i <= last; i++) {
		const r = role(seq[i]!);
		if (r === "deleted") before.push(i);
		else if (r === "wrote") after.push(i);
	}
	return { before, after };
}
