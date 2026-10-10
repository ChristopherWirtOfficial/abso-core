// Moves (#28): within one agent's unpublished draft, a line that leaves one place and the same
// text that arrives somewhere else is the same line. Before a publish, those matches become move
// atoms so the lines keep their ids. Writes go through ExpressMovesHost; today the host is Project.

import type { AtomId, AttrSet, EditInput, Graph, LineId, MoveInput, View } from "../../src/engine/index.ts";
import { PLAIN_LINE } from "./collisions.ts";
import type { AgentState, Entry, Meta, Mode } from "./project-types.ts";

/** The most moved blocks one publish expresses: the longest ones, when there are more. */
export const MOVE_LIMIT = 64;
/** About how many lines one publish may lay out to express moves: each move lays out its files again. */
export const MOVE_BUDGET = 200_000;
/** The most places one deleted text is tried as the start of a moved stretch. */
export const MATCH_STARTS = 256;

/** What expressing moves needs from a project. */
export interface ExpressMovesHost {
	readonly graph: Graph;
	draft(agent: AgentState): AtomId[];
	agentView(agent: AgentState): View;
	view(set: ReadonlySet<AtomId>): View;
	apply(entry: Entry): void;
	addDraft(
		agent: AgentState,
		view: View,
		input: { edits: readonly EditInput[]; attrs?: readonly AttrSet[]; move?: MoveInput },
		time: number,
		meta: Meta,
		entries: Entry[],
	): void;
	recordFile(
		agent: AgentState,
		view: View,
		path: string,
		text: string | null | undefined,
		time: number,
		meta: Meta,
		entries: Entry[],
		mode?: Mode,
	): boolean;
}

/**
 * Moves (#28). Within one agent's unpublished draft, a line that leaves one
 * place and the same text that arrives somewhere else is the same line, in
 * either order (deleted then written, or written then deleted). Before a
 * publish, the draft's changes to the files involved are dropped (a discard
 * entry) and made again: one move per matched block, which keeps the
 * lines' ids, then a change per file to the draft's final text. The files
 * end up exactly as the draft had them. A matched block needs a line with
 * real content: blank lines and lone brackets only travel next to one.
 * The agent's publishes waiting in the queue keep their changes: they count
 * as already there, never dropped (abso issue 135, item 4).
 */
export function expressMoves(host: ExpressMovesHost, agent: AgentState, time: number, entries: Entry[]): void {
	const draft = host.draft(agent);
	if (draft.length === 0) return;
	const g = host.graph;
	const mine = new Set(draft);
	const after = host.agentView(agent);
	const before = host.view(new Set([...after.set].filter((id) => !mine.has(id))));
	const touched = new Set<string>();
	for (const id of draft) for (const file of g.filesOf(id)) touched.add(file);

	// Blocks of lines the draft deleted, and runs of lines it wrote, each consecutive.
	interface Block {
		readonly file: string;
		readonly start: number;
		readonly ids: LineId[];
		readonly texts: string[];
	}
	const gone: Block[] = [];
	const written: Block[] = [];
	for (const file of [...touched].toSorted()) {
		let cur: Block | undefined;
		before.lines(file).forEach((l, i) => {
			if (g.deletersOf(l.id).some((d) => mine.has(d))) {
				if (!cur) gone.push((cur = { file, start: i, ids: [], texts: [] }));
				cur.ids.push(l.id);
				cur.texts.push(l.text);
			} else cur = undefined;
		});
		cur = undefined;
		after.lines(file).forEach((l, i) => {
			if (mine.has(l.atom)) {
				if (!cur) written.push((cur = { file, start: i, ids: [], texts: [] }));
				cur.ids.push(l.id);
				cur.texts.push(l.text);
			} else cur = undefined;
		});
	}
	if (gone.length === 0 || written.length === 0) return;

	// Match: for each written run, the longest stretches that some deleted block has too.
	interface Match {
		readonly from: string;
		readonly ids: LineId[];
		readonly to: string;
		/** Where the stretch starts in the draft's final text of `to`. */
		readonly at: number;
	}
	const used = new Set<LineId>();
	const matches: Match[] = [];
	// Where each deleted text starts a candidate, in block and line order (abso issue 158): a stretch
	// can only start where the texts are equal, so each written line looks only there, not at
	// every deleted line. A text deleted more than MATCH_STARTS times keeps its first ones.
	const starts = new Map<string, { block: Block; q: number }[]>();
	for (const block of gone)
		block.texts.forEach((t, q) => {
			const list = starts.get(t);
			if (!list) starts.set(t, [{ block, q }]);
			else if (list.length < MATCH_STARTS) list.push({ block, q });
		});
	for (const run of written) {
		let p = 0;
		while (p < run.texts.length) {
			let best: { block: Block; q: number; len: number } | undefined;
			for (const { block, q } of starts.get(run.texts[p]!) ?? []) {
				let len = 0;
				while (
					p + len < run.texts.length &&
					q + len < block.texts.length &&
					run.texts[p + len] === block.texts[q + len] &&
					!used.has(block.ids[q + len]!)
				) {
					len++;
				}
				if (len > 0 && (!best || len > best.len)) best = { block, q, len };
			}
			if (best?.block.texts.slice(best.q, best.q + best.len).some((t) => !PLAIN_LINE.test(t))) {
				const ids = best.block.ids.slice(best.q, best.q + best.len);
				for (const id of ids) used.add(id);
				matches.push({ from: best.block.file, ids, to: run.file, at: run.start + p });
				p += best.len;
			} else p++;
		}
	}
	if (matches.length === 0) return;
	// Each match lays its files out again, so the cost is matches times file length (abso issues 137,
	// 142): a rewritten 23,572-line JSON file made 438 matches, 399 of them one line, and the publish
	// passed Workers' CPU limit. So the longest blocks move first, up to MOVE_LIMIT of them and
	// MOVE_BUDGET lines laid out in all; the rest are a delete and a fresh write, as an unmatched block
	// always is.
	const length = (path: string) => (after.hasFile(path) ? after.lines(path).length : 0);
	const cost = (m: Match) => length(m.from) + (m.to === m.from ? 0 : length(m.to));
	const keep = new Set<Match>();
	let spent = 0;
	for (const { m } of matches
		.map((m, i) => ({ m, i }))
		.toSorted((a, b) => b.m.ids.length - a.m.ids.length || a.i - b.i)) {
		if (keep.size >= MOVE_LIMIT) break;
		if (keep.size > 0 && spent + cost(m) > MOVE_BUDGET) continue;
		spent += cost(m);
		keep.add(m);
	}
	for (let i = matches.length - 1; i >= 0; i--) if (!keep.has(matches[i]!)) matches.splice(i, 1);

	// Drop the draft's changes to the files involved, and whatever builds on them.
	const involved = new Set<string>(matches.flatMap((m) => [m.from, m.to]));
	const drop = new Set<AtomId>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const id of draft) {
			if (drop.has(id)) continue;
			const atom = g.atom(id);
			if (g.filesOf(id).some((f) => involved.has(f)) || atom.deps.some((d) => drop.has(d))) {
				drop.add(id);
				for (const f of g.filesOf(id)) involved.add(f);
				grew = true;
			}
		}
	}
	const discard: Entry = { type: "discard", agent: agent.name, atoms: draft.filter((id) => drop.has(id)) };
	entries.push(discard);
	host.apply(discard);

	for (const m of matches) {
		const view = host.agentView(agent);
		const start = view.lineNumber(m.from, m.ids[0]!);
		if (start < 0 || m.ids.some((id, k) => view.lineNumber(m.from, id) !== start + k)) continue;
		// Land after the nearest line above it in the final text that is already there.
		const finalLines = after.lines(m.to);
		let at = 0;
		for (let i = m.at - 1; i >= 0; i--) {
			const n = view.lineNumber(m.to, finalLines[i]!.id);
			if (n >= 0) {
				at = n + 1;
				break;
			}
		}
		if (m.to === m.from && at >= start && at <= start + m.ids.length) continue;
		host.addDraft(
			agent,
			view,
			{ edits: [], move: { file: m.from, start, end: start + m.ids.length, to: m.to, at } },
			time,
			{},
			entries,
		);
	}
	for (const path of [...involved].toSorted()) {
		const was = after.attrs(path);
		host.recordFile(
			agent,
			host.agentView(agent),
			path,
			after.hasFile(path) ? after.text(path) : null,
			time,
			{},
			entries,
			{
				exec: was.exec,
				link: was.link,
			},
		);
	}
}
