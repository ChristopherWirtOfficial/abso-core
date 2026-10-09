// Building an atom from an edit against a view. Agents say "replace this exact
// text with that text" (or "replace these visible lines with these lines");
// the engine turns it into deletes, inserts, claim keys and derived deps.

import { Graph } from "./graph.ts";
import { attrKey, gapKey, isStartNode, lineKey, parseKey, posKey, startNode, writerOf } from "./keys.ts";
import { diffLines, joinLines, normalizeText, splitLines } from "./text.ts";
import {
	ATTR_NAMES,
	type Atom,
	type AtomId,
	type AttrSet,
	EngineError,
	type InsertRun,
	type Key,
	type LineId,
	MODES,
	type Mode,
	type NodeId,
	REASON_KINDS,
	type Reason,
	type Relocation,
} from "./types.ts";
import { View } from "./view.ts";

/** Replace the one exact occurrence of `old` in `file` with `new`. */
export interface TextEdit {
	readonly file: string;
	readonly old: string;
	readonly new: string;
	readonly mode?: Mode;
}

/**
 * Replace visible lines [start, end) of `file` (0-based) with `lines`. With
 * start === end it is a pure insertion before line `start`. This is the form
 * a git hunk maps onto.
 */
export interface SpliceEdit {
	readonly file: string;
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
	readonly mode?: Mode;
}

export type EditInput = TextEdit | SpliceEdit;

/** Visible lines [start, end) of a file, 0-based, end exclusive, non-empty. */
export interface LineRange {
	readonly file: string;
	readonly start: number;
	readonly end: number;
}

/**
 * Move visible lines [start, end) of `file` (0-based, non-empty) so they sit
 * just before visible line `at` of `to` (at === its line count: the end).
 * `to` may be the same file, with `at` outside [start, end]. The lines keep
 * their ids, so edits to them, made before or after, follow them (#28).
 */
export interface MoveInput {
	readonly file: string;
	readonly start: number;
	readonly end: number;
	readonly to: string;
	readonly at: number;
}

export interface AtomInput {
	readonly author: string;
	/** The why. */
	readonly message: string;
	/** Milliseconds since the epoch. Defaults to 0; the engine never reads a clock. */
	readonly time?: number;
	/** Edits, all matched against the same view; their line spans may not overlap. */
	readonly edits?: readonly EditInput[];
	/**
	 * "My change relies on these lines staying as they are": holds each line and
	 * the gaps between them, so an edit landing anywhere in the range trips it.
	 */
	readonly reliesOn?: readonly LineRange[];
	/** Claim spans: hold these lines and the gaps between them (what a claim-only atom is made of). */
	readonly spans?: readonly LineRange[];
	/** Explicit dependencies. */
	readonly needs?: readonly AtomId[];
	/** Atoms whose conflict this atom settles. Implies needs. */
	readonly resolves?: readonly AtomId[];
	readonly reasons?: readonly Reason[];
	/** File attributes to set: an empty file's existence, the executable bit, a link target. */
	readonly attrs?: readonly AttrSet[];
	/** One block of lines to move. Not together with edits. */
	readonly move?: MoveInput;
}

/** An edit after matching: visible lines [start, end) of `file` become `lines`. */
interface Region {
	readonly file: string;
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
	readonly mode: Mode;
	readonly order: number;
}

/**
 * Build (but do not accept) an atom from edits against a view. The atom gets
 * the graph's next id; accept it with `graph.add(atom)` and put it in a set.
 * Its dependencies are derived from what it touched in the view (see deriveDeps).
 */
export function buildAtom(view: View, input: AtomInput): Atom {
	return build(view, input, false);
}

/** The starting snapshot: a0, inserting every line of every file. Empty files are skipped. */
export function buildBase(
	files: Readonly<Record<string, string>>,
	meta: { author: string; message: string; time?: number },
	attrs: readonly AttrSet[] = [],
): Atom {
	const view = new View(new Graph(), []);
	const edits: TextEdit[] = Object.keys(files)
		.sort()
		.filter((file) => files[file] !== "")
		.map((file) => ({ file, old: "", new: files[file]! }));
	return build(view, { ...meta, edits, attrs }, true);
}

function build(view: View, input: AtomInput, allowEmpty: boolean): Atom {
	const graph = view.graph;
	const id = graph.nextId();
	if (typeof input.author !== "string" || typeof input.message !== "string") {
		throw new EngineError("bad-edit", "an atom needs an author and a message");
	}
	const time = input.time ?? 0;
	if (!Number.isFinite(time)) throw new EngineError("bad-edit", "time must be a finite number");

	const regions = resolveRegions(view, input.edits ?? []);
	if (input.move !== undefined && regions.length > 0)
		throw new EngineError("bad-edit", "a move goes in an atom of its own, without edits");

	const inserts: InsertRun[] = [];
	const deletes: LineId[] = [];
	const writes = new Set<Key>();
	const reads = new Set<Key>();
	const holds = new Set<Key>();
	const emptiedBy = new Set<AtomId>();

	for (const region of regions) {
		const visible = view.lines(region.file);
		const oldLines = visible.slice(region.start, region.end).map((l) => l.text);
		for (const hunk of diffLines(oldLines, region.lines)) {
			const start = region.start + hunk.start;
			const end = region.start + hunk.end;
			let parent: NodeId;
			if (end > start) {
				// Replacement: delete the old lines; new lines hang off the last deleted one.
				for (let i = start; i < end; i++) {
					const line = visible[i]!.id;
					deletes.push(line);
					writes.add(lineKey(line));
				}
				parent = visible[end - 1]!.id;
			} else {
				// Pure insertion between X (above, or the start node) and Y (below, or end of file).
				const above = start > 0 ? visible[start - 1]!.id : undefined;
				const below = start < visible.length ? visible[start]!.id : undefined;
				parent = above ?? startNode(region.file);
				writes.add(gapKey(parent));
				// after reads only X and before only Y; at the edge of a file each
				// reads the neighbour there is, so an insertion into a non-empty file
				// always claims a line of it.
				if (above !== undefined && (region.mode !== "before" || below === undefined)) reads.add(lineKey(above));
				if (below !== undefined && (region.mode !== "after" || above === undefined)) reads.add(lineKey(below));
				// Creating a file over a deleted one relies on it being empty.
				if (visible.length === 0) {
					for (const line of view.sequence(region.file)) for (const d of line.deletedBy) emptiedBy.add(d);
				}
			}
			if (hunk.lines.length > 0) inserts.push({ file: region.file, parent, lines: [...hunk.lines] });
		}
		if (region.mode === "wide")
			holdSpan(
				visible.slice(region.start, region.end).map((l) => l.id),
				holds,
			);
	}

	const moves = input.move !== undefined ? planMove(view, input.move, writes, reads) : [];

	const attrs: AttrSet[] = [];
	for (const a of input.attrs ?? []) {
		if (typeof a?.file !== "string" || a.file === "" || /[\n\r]/.test(a.file) || !ATTR_NAMES.includes(a.name)) {
			throw new EngineError("bad-edit", `an attribute needs a file and one of ${ATTR_NAMES.join(", ")}`);
		}
		if (a.value !== null && typeof a.value !== "string")
			throw new EngineError("bad-edit", "an attribute value is a string or null");
		if (attrs.some((x) => x.file === a.file && x.name === a.name))
			throw new EngineError("bad-edit", `${a.name} of ${a.file} set twice`);
		attrs.push({ file: a.file, name: a.name, value: a.value });
		writes.add(attrKey(a.file, a.name));
	}

	for (const range of input.reliesOn ?? []) holdSpan(rangeLines(view, range), holds);
	for (const range of input.spans ?? []) holdSpan(rangeLines(view, range), holds);

	const needs = uniqueAtoms(view, input.needs ?? [], "needs");
	const resolves = uniqueAtoms(view, input.resolves ?? [], "resolves");
	const reasons = (input.reasons ?? []).map((r) => {
		if (!REASON_KINDS.includes(r.kind)) {
			throw new EngineError("bad-edit", `reason kind must be one of ${REASON_KINDS.join(", ")}, not ${String(r.kind)}`);
		}
		if (!graph.has(r.to)) throw new EngineError("unknown-atom", `reason points at unknown atom ${r.to}`);
		if (typeof r.text !== "string") throw new EngineError("bad-edit", "a reason needs text");
		return { to: r.to, kind: r.kind, text: r.text };
	});

	const nothing =
		inserts.length === 0 &&
		deletes.length === 0 &&
		holds.size === 0 &&
		needs.length === 0 &&
		resolves.length === 0 &&
		reasons.length === 0 &&
		attrs.length === 0 &&
		moves.length === 0;
	if (nothing && !allowEmpty) {
		throw new EngineError("empty-atom", "the edit changes nothing and claims nothing");
	}

	const sortedWrites = [...writes].sort();
	const sortedReads = [...reads].sort();
	const sortedHolds = [...holds].sort();
	const deps = deriveDeps(view, {
		writes: sortedWrites,
		reads: sortedReads,
		holds: sortedHolds,
		emptiedBy,
		needs,
		resolves,
	});

	return {
		id,
		seq: graph.size,
		author: input.author,
		message: input.message,
		time,
		inserts,
		deletes,
		writes: sortedWrites,
		reads: sortedReads,
		holds: sortedHolds,
		needs,
		resolves,
		reasons,
		deps,
		...(attrs.length > 0 ? { attrs } : {}),
		...(moves.length > 0 ? { moves } : {}),
	};
}

/**
 * The relocations that move a block. In the file's full sequence (tombstones
 * included), the block runs from its first line to its last. Afterwards the
 * block must sit right after D (the visible line before `at`, or the start
 * node), and everything else must keep its order. So:
 * - the block's first line moves to D;
 * - a later block line whose parent is outside the block moves to the block
 *   line before it (which has no children, the walk being depth-first);
 * - a line after the block whose parent is inside it moves to the line before
 *   it once the block is gone (the line before the block, for the first).
 * It writes P: of every block line and of every line it relocates, and G: of
 * every new parent. It reads P:D, so two moves made apart that would loop
 * lines into each other collide in all but the rarest cases (the view breaks
 * any loop that is left).
 */
function planMove(view: View, move: MoveInput, writes: Set<Key>, reads: Set<Key>): Relocation[] {
	for (const path of [move.file, move.to]) {
		if (typeof path !== "string" || path === "" || /[\n\r]/.test(path))
			throw new EngineError("bad-edit", `bad file path ${JSON.stringify(path)}`);
	}
	const visible = view.lines(move.file);
	const { start, end, at } = move;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > visible.length || start >= end) {
		throw new EngineError(
			"bad-range",
			`${move.file} lines [${start}, ${end}) are not a non-empty range of its ${visible.length} visible lines`,
		);
	}
	const dest = view.lines(move.to);
	if (!Number.isInteger(at) || at < 0 || at > dest.length) {
		throw new EngineError("bad-range", `${move.to} has no place ${at} (it has ${dest.length} visible lines)`);
	}
	if (move.to === move.file && at >= start && at <= end)
		throw new EngineError("bad-range", "the lines are already there");
	const sequence = view.sequence(move.file);
	const i = view.sequenceIndex(move.file, visible[start]!.id);
	const j = view.sequenceIndex(move.file, visible[end - 1]!.id);
	const block = sequence.slice(i, j + 1).map((l) => l.id);
	const inBlock = new Set(block);
	const target: NodeId = at > 0 ? dest[at - 1]!.id : startNode(move.to);

	const out: Relocation[] = [{ line: block[0]!, parent: target }];
	for (let k = 1; k < block.length; k++) {
		if (!inBlock.has(view.parentOf(block[k]!))) out.push({ line: block[k]!, parent: block[k - 1]! });
	}
	for (let m = j + 1; m < sequence.length; m++) {
		const line = sequence[m]!.id;
		if (!inBlock.has(view.parentOf(line))) continue;
		const parent = m === j + 1 ? (i > 0 ? sequence[i - 1]!.id : startNode(move.file)) : sequence[m - 1]!.id;
		out.push({ line, parent });
	}
	for (const line of block) writes.add(posKey(line));
	for (const r of out) {
		writes.add(posKey(r.line));
		writes.add(gapKey(r.parent));
	}
	if (!isStartNode(target)) reads.add(posKey(target));
	return out;
}

/**
 * Derived dependencies of a new atom against its view (docs/prototype.md,
 * "Dependencies"):
 * - blame: the writers of every line its keys name (a G: key names the line
 *   the gap follows);
 * - gap rule: atoms in the view that wrote a gap it inserts into or holds.
 *   Their lines hang off the same line, so the new run outranks all of them
 *   and lands directly after its parent;
 * - implicit-read rule: atoms in the view whose implicit reads include a key
 *   it writes (it saw that insert and changed its neighbour);
 * - creating a file over a deleted one: the atoms that deleted its lines;
 * - needs and resolves.
 * Nothing else from the view: not the line below an insertion, not the
 * tombstones around it.
 */
function deriveDeps(
	view: View,
	parts: {
		writes: readonly Key[];
		reads: readonly Key[];
		holds: readonly Key[];
		emptiedBy: ReadonlySet<AtomId>;
		needs: readonly AtomId[];
		resolves: readonly AtomId[];
	},
): AtomId[] {
	const graph = view.graph;
	const deps = new Set<AtomId>(parts.emptiedBy);
	for (const key of [...parts.writes, ...parts.reads, ...parts.holds]) {
		const { kind, node } = parseKey(key);
		// An attribute builds on whoever set it last in the view, the way an insertion builds on a gap's writers;
		// a move builds on the earlier moves of its lines.
		if (kind !== "attr" && !isStartNode(node)) deps.add(writerOf(node));
		if (kind !== "line") for (const writer of graph.writersOf(key)) if (view.set.has(writer)) deps.add(writer);
	}
	for (const key of parts.writes) {
		for (const reader of graph.readersOf(key)) if (view.set.has(reader)) deps.add(reader);
	}
	for (const id of parts.needs) deps.add(id);
	for (const id of parts.resolves) deps.add(id);
	return [...deps].sort((a, b) => graph.atom(a).seq - graph.atom(b).seq);
}

/** Hold every line of a span and every gap between consecutive lines of it. */
function holdSpan(lines: readonly LineId[], holds: Set<Key>): void {
	lines.forEach((line, i) => {
		holds.add(lineKey(line));
		if (i + 1 < lines.length) holds.add(gapKey(line));
	});
}

function rangeLines(view: View, range: LineRange): LineId[] {
	const visible = view.lines(range.file);
	if (
		!Number.isInteger(range.start) ||
		!Number.isInteger(range.end) ||
		range.start < 0 ||
		range.end > visible.length ||
		range.start >= range.end
	) {
		throw new EngineError(
			"bad-range",
			`${range.file} lines [${range.start}, ${range.end}) are not a non-empty range of its ${visible.length} visible lines`,
		);
	}
	return visible.slice(range.start, range.end).map((l) => l.id);
}

function uniqueAtoms(view: View, ids: readonly AtomId[], what: string): AtomId[] {
	const out: AtomId[] = [];
	for (const id of ids) {
		if (!view.graph.has(id)) throw new EngineError("unknown-atom", `${what} names unknown atom ${id}`);
		if (!view.set.has(id)) throw new EngineError("not-in-view", `${what} names ${id}, which is not in the view`);
		if (!out.includes(id)) out.push(id);
	}
	return out.sort((a, b) => view.graph.atom(a).seq - view.graph.atom(b).seq);
}

// Matching edits ---------------------------------------------------------------

function resolveRegions(view: View, edits: readonly EditInput[]): Region[] {
	const regions = edits.map((edit, order) => {
		const mode = edit.mode ?? "both";
		if (!MODES.includes(mode)) throw new EngineError("bad-edit", `mode must be one of ${MODES.join(", ")}`);
		// A path may start with '^' (a start node is '^' + path, so '^^x' stays unambiguous).
		if (typeof edit.file !== "string" || edit.file === "" || /[\n\r]/.test(edit.file)) {
			throw new EngineError("bad-edit", `bad file path ${JSON.stringify(edit.file)}`);
		}
		return "old" in edit ? matchText(view, edit, mode, order) : matchSplice(view, edit, mode, order);
	});

	// Files in order of first appearance; within a file, regions in position order.
	const fileOrder = new Map<string, number>();
	for (const r of regions) if (!fileOrder.has(r.file)) fileOrder.set(r.file, fileOrder.size);
	regions.sort(
		(a, b) =>
			fileOrder.get(a.file)! - fileOrder.get(b.file)! || a.start - b.start || a.end - b.end || a.order - b.order,
	);
	for (let i = 1; i < regions.length; i++) {
		const prev = regions[i - 1]!;
		const cur = regions[i]!;
		if (prev.file === cur.file && prev.end > cur.start) {
			throw new EngineError(
				"overlapping-edits",
				`two edits to ${cur.file} overlap (lines ${prev.start + 1}-${prev.end} and ${cur.start + 1}-${cur.end})`,
			);
		}
	}
	return regions;
}

/**
 * Find `old` (exactly once) in the file's visible text and widen the match to
 * whole lines. If the replacement would leave a line without its newline, the
 * next line joins the region (that is what the plain-text edit does).
 */
function matchText(view: View, edit: TextEdit, mode: Mode, order: number): Region {
	if (typeof edit.old !== "string" || typeof edit.new !== "string") {
		throw new EngineError("bad-edit", "a text edit needs old and new strings");
	}
	const file = edit.file;
	const visible = view.lines(file);
	const oldText = normalizeText(edit.old);
	const newText = normalizeText(edit.new);
	if (oldText === "") {
		if (visible.length > 0) {
			throw new EngineError(
				"ambiguous-match",
				`empty old text matches everywhere in ${file}; an empty old text only creates a file`,
			);
		}
		return { file, start: 0, end: 0, lines: splitLines(newText), mode, order };
	}
	const text = joinLines(visible.map((l) => l.text));
	const at = text.indexOf(oldText);
	if (at < 0) throw new EngineError("no-match", `old text not found in ${file}`);
	if (text.indexOf(oldText, at + 1) >= 0) {
		throw new EngineError(
			"ambiguous-match",
			`old text matches more than once in ${file}; add context to make it unique`,
		);
	}
	const starts: number[] = [];
	let pos = 0;
	for (const line of visible) {
		starts.push(pos);
		pos += line.text.length + 1;
	}
	const lineAt = (offset: number): number => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid]! <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const end = at + oldText.length;
	const startLine = lineAt(at);
	let endLine = lineAt(end - 1);
	const lineStart = starts[startLine]!;
	const lineEnd = starts[endLine]! + visible[endLine]!.text.length + 1;
	let replacement = text.slice(lineStart, at) + newText + text.slice(end, lineEnd);
	if (replacement !== "" && !replacement.endsWith("\n")) {
		if (endLine + 1 < visible.length) {
			endLine++;
			replacement += visible[endLine]!.text + "\n";
		} else {
			replacement += "\n";
		}
	}
	return { file, start: startLine, end: endLine + 1, lines: splitLines(replacement), mode, order };
}

function matchSplice(view: View, edit: SpliceEdit, mode: Mode, order: number): Region {
	const count = view.lines(edit.file).length;
	if (
		!Number.isInteger(edit.start) ||
		!Number.isInteger(edit.end) ||
		edit.start < 0 ||
		edit.start > edit.end ||
		edit.end > count
	) {
		throw new EngineError(
			"bad-range",
			`${edit.file} lines [${edit.start}, ${edit.end}) are outside its ${count} visible lines`,
		);
	}
	if (!Array.isArray(edit.lines)) throw new EngineError("bad-edit", "a splice edit needs lines");
	const lines = edit.lines.map((line) => {
		if (typeof line !== "string" || /[\n\r]/.test(line)) {
			throw new EngineError("bad-edit", "splice lines must be strings without line breaks");
		}
		return line;
	});
	return { file: edit.file, start: edit.start, end: edit.end, lines, mode, order };
}
