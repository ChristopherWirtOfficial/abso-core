// After a sync, merge files where the agent's draft and the newer work collide the way git
// merges a file (#25, Fuzzer). Writes go through MergeHost; today the host is Project.

import {
	type AtomId,
	type Graph,
	type Hunk,
	joinLines,
	mergeLines,
	mergeWords,
	type ReadView,
	splitLines,
} from "../../src/engine/index.ts";
import type { Origin, Pair } from "./collisions.ts";
import { type MarkedRegion, markedHunks, markerBlock } from "./markers.ts";
import type { AgentState, Entry, MergedLine, Meta, Mode } from "./project-types.ts";
import type { Space } from "./spaces.ts";

/** What the identical-line merge at sync needs from a project. */
export interface MergeHost {
	readonly graph: Graph;
	openPairs(agent: AgentState): Pair[];
	draft(agent: AgentState): AtomId[];
	origin(atom: AtomId, spaceName: string): Origin;
	view(set: ReadonlySet<AtomId>): ReadView;
	viewAt(space: Space, version: number): ReadView;
	spaceOf(agent: AgentState): Space;
	apply(entry: Entry): void;
	agentView(agent: AgentState): ReadView;
	recordFile(
		agent: AgentState,
		view: ReadView,
		path: string,
		text: string | null | undefined,
		time: number,
		meta: Meta,
		entries: Entry[],
		mode?: Mode,
		blob?: string,
		hunks?: readonly Hunk[],
	): boolean;
}

/**
 * After a sync, merge files where the agent's draft and the newer work
 * collide, the way git merges a file (#25, Fuzzer): from the agent's old
 * base, its draft's text and the newer text. Changes both made identically
 * are kept once; changes on one side are kept. Only when every file
 * involved merges with no conflict are the draft's changes to them dropped
 * (a discard entry) and made again as the merged text. Otherwise nothing
 * changes, and the collision stands with both sides' lines in the file.
 */
export function mergeIdentical(
	host: MergeHost,
	agent: AgentState,
	before: ReadView,
	oldBase: ReadonlySet<AtomId>,
	oldVersion: number,
	time: number,
	entries: Entry[],
): MergedLine[] {
	const pairs = host.openPairs(agent);
	if (pairs.length === 0) return [];
	const g = host.graph;
	const draft = host.draft(agent);
	const mine = new Set(draft);
	// A collision an earlier sync already showed stands (#37): the
	// old base has their lines, so a merge from it would read the draft's
	// copy of both sides as the draft adding a line, and keep both silently.
	const fresh = pairs.filter((p) => mine.has(p.yours) && !oldBase.has(p.theirs));
	const shown = new Set<string>();
	for (const p of pairs)
		if (mine.has(p.yours) && oldBase.has(p.theirs)) for (const f of g.filesOf(p.yours)) shown.add(f);
	const involved = new Set<string>();
	for (const p of fresh) for (const f of g.filesOf(p.yours)) involved.add(f);
	if (involved.size === 0) return [];
	const theirsBy = new Map<string, AtomId>();
	for (const p of fresh) for (const f of g.filesOf(p.yours)) if (!theirsBy.has(f)) theirsBy.set(f, p.theirs);
	const drop = new Set<AtomId>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const id of draft) {
			if (drop.has(id)) continue;
			if (g.filesOf(id).some((f) => involved.has(f)) || g.atom(id).deps.some((d) => drop.has(d))) {
				drop.add(id);
				for (const f of g.filesOf(id)) involved.add(f);
				grew = true;
			}
		}
	}
	if ([...involved].some((f) => shown.has(f))) return [];
	const baseView = host.view(oldBase);
	const theirs = host.viewAt(host.spaceOf(agent), agent.base);
	const textOf = (v: ReadView, path: string): string | null => (v.hasFile(path) ? v.text(path) : null);
	const merged = new Map<string, { text: string | null; mode: Mode; hunks?: Hunk[] }>();
	const notices: MergedLine[] = [];
	const regions: MarkedRegion[] = [];
	const spaceName = host.spaceOf(agent).name;
	const hunksBy = new Map<string, Hunk[]>();
	// One line both sides changed: merged word by word, and told (#37).
	const oneLine = (span: readonly string[], o: readonly string[], t: readonly string[]): string[] | undefined => {
		if (span.length !== 1 || o.length !== 1 || t.length !== 1) return undefined;
		const m = mergeWords(span[0]!, o[0]!, t[0]!);
		return m === undefined ? undefined : [m];
	};
	for (const path of [...involved].toSorted()) {
		if (baseView.attrs(path).blob || before.attrs(path).blob || theirs.attrs(path).blob) return [];
		const b = textOf(baseView, path);
		const o = textOf(before, path);
		const t = textOf(theirs, path);
		let text: string | null;
		if (o === t || t === b) text = o;
		else if (o === b) text = t;
		else if (o === null || t === null || b === null) return [];
		else {
			const by = theirsBy.get(path);
			const origin = by ? host.origin(by, spaceName) : undefined;
			const theirLines = theirs.lines(path);
			const spans: { theirsAt: number; theirs: number }[] = [];
			// Lines both sides changed differently (#11, round 1): written with
			// markers, theirs labeled with who published it, so the file can't
			// pass for finished code until the agent settles it.
			const m = mergeLines(splitLines(b), splitLines(o), splitLines(t), oneLine, (c) => {
				// Labeled by the first of their lines that is newer than the agent's old base (#37):
				// the block can start with an older line nobody changed, by anyone, even the agent itself.
				const span = theirLines.slice(c.theirsAt, c.theirsAt + c.theirs.length);
				const first = span.find((l) => !oldBase.has(l.atom)) ?? span[0];
				const from = c.theirs.length > 0 && first ? host.origin(first.atom, spaceName) : origin;
				const who = {
					agent: from?.agent ?? "someone",
					version: from?.version ?? agent.base,
					message: from?.message ?? "",
				};
				// The changes that collided, so the edit that takes the markers out is recorded as settling them (why shows it).
				const yoursAtoms = before
					.lines(path)
					.slice(c.oursAt, c.oursAt + c.ours.length)
					.map((l) => l.atom)
					.filter((id) => mine.has(id));
				const fallback = fresh.filter((p) => g.filesOf(p.yours).includes(path)).map((p) => p.yours);
				const theirAtom = c.theirs.length > 0 && first ? first.atom : by;
				const settles = [
					...new Set([...(yoursAtoms.length > 0 ? yoursAtoms : fallback), ...(theirAtom ? [theirAtom] : [])]),
				];
				regions.push({ file: path, yours: [...c.ours], base: [...c.base], theirs: [...c.theirs], ...who, settles });
				spans.push({ theirsAt: c.theirsAt, theirs: c.theirs.length });
				return markerBlock(c.ours, c.base, oldVersion, c.theirs, who);
			});
			text = joinLines(m.lines);
			// Their lines inside each block stay their lines: the markers and yours go in around them.
			if (spans.length > 0)
				hunksBy.set(
					path,
					markedHunks(
						splitLines(t),
						m.lines,
						m.conflictsAt.map((c, i) => ({ ...c, ...spans[i]! })),
					),
				);
			for (const at of m.resolved) {
				notices.push({
					file: path,
					line: at + 1,
					text: m.lines[at]!,
					...(origin ? { theirs: { agent: origin.agent, message: origin.message, version: origin.version } } : {}),
				});
			}
		}
		// The mode: ours if we changed it, else theirs.
		const ab = baseView.attrs(path);
		const ao = before.attrs(path);
		const at = theirs.attrs(path);
		const mode: Mode = {
			exec: ao.exec !== ab.exec ? ao.exec : at.exec,
			link: ao.link !== ab.link ? ao.link : at.link,
		};
		merged.set(path, { text, mode, ...(hunksBy.has(path) ? { hunks: hunksBy.get(path)! } : {}) });
	}
	const discard: Entry = {
		type: "discard",
		agent: agent.name,
		atoms: draft.filter((id) => drop.has(id)),
		...(regions.length > 0 ? { markers: regions } : {}),
	};
	entries.push(discard);
	host.apply(discard);
	for (const [path, m] of merged) {
		const view = host.agentView(agent);
		// The hunks are against their text, which the view now shows; anything else is diffed as usual.
		const hunks = m.hunks && view.hasFile(path) && view.text(path) === textOf(theirs, path) ? m.hunks : undefined;
		host.recordFile(agent, view, path, m.text, time, {}, entries, m.mode, undefined, hunks);
	}
	return notices;
}
