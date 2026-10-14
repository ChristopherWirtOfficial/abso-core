// Who's working where (slice 2 of #18): for each file, the agents whose
// drafts touch it, which lines, and when they last edited. Lines are given
// two ways: in the agent's own view (what its folder shows), and in shared's
// numbering (the shared lines it changes, or the shared line its new lines
// follow), so agents can compare where they are against one common text.
import type { AtomId, LineId } from "../../src/engine/index.ts";
import type { Project } from "./project.ts";

type Range = [number, number];

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
	let shared: ReturnType<Project["sharedView"]> | undefined;
	const sharedNumber = (file: string, id: LineId): number | undefined => {
		shared ??= project.sharedView();
		if (!shared.hasFile(file)) return undefined;
		const i = shared.lines(file).findIndex((l) => l.id === id);
		return i >= 0 ? i + 1 : undefined;
	};
	const files: Record<string, Spot[]> = {};
	for (const agent of project.agents()) {
		const draft = project.draftOf(agent);
		if (!draft || draft.atoms.length === 0) continue;
		const mine = new Set<AtomId>(draft.atoms);
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
				const file = run.parent.startsWith("^") ? run.file : draft.view.fileOf(run.parent);
				const s = at(file);
				s.changes.add(id);
				s.last = Math.max(s.last, atom.time);
				// The shared line its new lines follow ("^path" is the top of the file: line 0).
				const anchor = run.parent.startsWith("^") ? 0 : sharedNumber(file, run.parent);
				if (anchor !== undefined) s.shared.push(Math.max(anchor, 1));
			}
			for (const lineId of atom.deletes) {
				const info = graph.line(lineId);
				if (!info) continue;
				const file = draft.view.fileOf(lineId);
				const s = at(file);
				s.changes.add(id);
				s.last = Math.max(s.last, atom.time);
				const n = sharedNumber(file, lineId);
				if (n !== undefined) s.shared.push(n);
			}
		}
		for (const [file, s] of perFile) {
			if (draft.view.hasFile(file)) {
				draft.view.lines(file).forEach((l, i) => {
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
