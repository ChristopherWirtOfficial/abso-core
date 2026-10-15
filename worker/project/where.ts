// Who's working where (slice 2 of #18): for each file, the agents whose
// drafts touch it, which lines, and when they last edited. Lines are given
// two ways: in the agent's own view (what its folder shows), and in shared's
// numbering (the shared lines it changes, or the shared line its new lines
// follow), so agents can compare where they are against one common text.
import { type AtomId, type LineId, type ReadView, seqOf } from "../../src/engine/index.ts";
import type { Project } from "./project.ts";

type Range = [number, number];

/** A view's reads by line number (View has them; another ReadView may not). */
type ByNumber = ReadView & {
	fileOfNumber?(n: number): string;
	lineNumberOf?(path: string, n: number): number;
	visibleWriters?(path: string): readonly number[];
};

function ranges(ns: number[]): Range[] {
	const out: Range[] = [];
	for (const n of [...new Set(ns)].sort((a, b) => a - b)) {
		const last = out.at(-1);
		if (last && n === last[1] + 1) last[1] = n;
		else out.push([n, n]);
	}
	return out;
}

export interface Spot {
	agent: string;
	/** Line ranges in the agent's own view. */
	lines: Range[];
	/** Line ranges in shared: lines it deletes or rewrites, and the lines its new lines come after. */
	shared: Range[];
	changes: number;
	lastEdit: number;
}

export function where(project: Project) {
	const graph = project.graph;
	let shared: ByNumber | undefined;
	// By the file's index of visible lines (abso Capacity): finding it in lines() built every line of the file again
	// whenever the file changed, per line asked.
	const sharedNumber = (file: string, line: LineId | number): number | undefined => {
		shared ??= project.sharedView() as ByNumber;
		if (!shared.hasFile(file)) return undefined;
		const i =
			typeof line === "string"
				? shared.lineNumber(file, line)
				: shared.lineNumberOf
					? shared.lineNumberOf(file, line)
					: shared.lineNumber(file, graph.lineIdOf(line));
		return i >= 0 ? i + 1 : undefined;
	};
	const files: Record<string, Spot[]> = {};
	for (const agent of project.agents()) {
		const draft = project.draftOf(agent);
		if (!draft || draft.atoms.length === 0) continue;
		const mine = new Set<AtomId>(draft.atoms);
		// Once per agent (abso Capacity): each read of draft.view asks the project's view cache, which weighs every
		// view it holds.
		const view = draft.view as ByNumber;
		const fileOfNumber = view.fileOfNumber?.bind(view);
		const perFile = new Map<string, { view: number[]; shared: number[]; changes: Set<AtomId>; last: number }>();
		const at = (file: string) => {
			let s = perFile.get(file);
			if (!s) perFile.set(file, (s = { view: [], shared: [], changes: new Set(), last: 0 }));
			return s;
		};
		for (const id of draft.atoms) {
			const atom = graph.atom(id);
			for (const run of atom.inserts) {
				// A line moved by someone (#28) is in the file the draft's view puts it in.
				const file = run.parent.startsWith("^") ? run.file : view.fileOf(run.parent);
				const s = at(file);
				s.changes.add(id);
				s.last = Math.max(s.last, atom.time);
				// The shared line its new lines follow ("^path" is the top of the file: line 0).
				const anchor = run.parent.startsWith("^") ? 0 : sharedNumber(file, run.parent);
				if (anchor !== undefined) s.shared.push(Math.max(anchor, 1));
			}
			// By number where the view can (abso Capacity): a draft deleting a big generated file read every line's text
			// to check it exists, and looked up each line's id.
			if (fileOfNumber) {
				for (const line of graph.deletedNumbers(id)) {
					const file = fileOfNumber(line);
					const s = at(file);
					s.changes.add(id);
					s.last = Math.max(s.last, atom.time);
					const n = sharedNumber(file, line);
					if (n !== undefined) s.shared.push(n);
				}
				continue;
			}
			for (const lineId of atom.deletes) {
				const info = graph.line(lineId);
				if (!info) continue;
				const file = view.fileOf(lineId);
				const s = at(file);
				s.changes.add(id);
				s.last = Math.max(s.last, atom.time);
				const n = sharedNumber(file, lineId);
				if (n !== undefined) s.shared.push(n);
			}
		}
		for (const [file, s] of perFile) {
			if (view.hasFile(file)) {
				if (view.visibleWriters) {
					const seqs = new Set(draft.atoms.map(seqOf));
					view.visibleWriters(file).forEach((seq, i) => {
						if (seqs.has(seq)) s.view.push(i + 1);
					});
				} else
					view.lines(file).forEach((l, i) => {
						if (mine.has(l.atom)) s.view.push(i + 1);
					});
			}
			(files[file] ??= []).push({
				agent,
				lines: ranges(s.view),
				shared: ranges(s.shared),
				changes: s.changes.size,
				lastEdit: s.last,
			});
		}
	}
	// What agents said they are starting on (#37, #13), whether or not an edit has landed yet.
	return { version: project.version, files, starting: project.startingNotes() };
}
