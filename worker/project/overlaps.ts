// Other agents whose unpublished changes or starting notes meet a file, and
// the news when a draft first touches one. Reads and news writes go through
// OverlapHost; today the host is Project. overlapsOf is the pure match.

import { type AtomId, type Graph, isStartNode, type ReadView } from "../../src/engine/index.ts";
import { matchesPattern, pathsInText, patternsMeet } from "./globs.ts";
import { type NewsItem, overlapItems } from "./news.ts";
import type { AgentState, Entry, Overlap, Starting } from "./project-types.ts";

/** Another agent in the same space, as overlaps see it. */
export interface OverlapPeer {
	name: string;
	/** Files its unpublished changes touch. */
	files: ReadonlySet<string>;
	/** How many of its unpublished changes touch `file`. */
	changesIn: (file: string) => number;
	/** Its live starting note. */
	note: Starting | undefined;
}

/** What draft-file overlaps and their news need from a project. */
export interface OverlapHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, AgentState>;
	agentView(agent: AgentState): ReadView;
	draft(agent: AgentState): readonly AtomId[];
	/** draftFiles below, kept per agent by the host. */
	draftFiles(agent: AgentState): Set<string>;
	liveNote(agent: AgentState): Starting | undefined;
	queueNews(agent: AgentState, items: readonly NewsItem[], entries: Entry[]): void;
}

/** What a starting note can name: its files (globs included) and the paths written in its text. */
export const notePatterns = (note: Starting | undefined): string[] =>
	note ? [...new Set([...note.files, ...pathsInText(note.text)])] : [];

/**
 * Peers with unpublished changes in a file `patterns` match, or a starting
 * note that can name the same file (#37: notes name files by glob,
 * or only in their text).
 */
export function overlapsOf(peers: readonly OverlapPeer[], patterns: readonly string[]): Overlap[] {
	if (patterns.length === 0) return [];
	const out: Overlap[] = [];
	for (const other of peers.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
		const found = new Map<string, Overlap>();
		for (const file of [...other.files].toSorted()) {
			if (!patterns.some((p) => matchesPattern(p, file))) continue;
			found.set(file, { agent: other.name, file, changes: other.changesIn(file) });
		}
		for (const theirs of notePatterns(other.note)) {
			for (const p of patterns) {
				if (!patternsMeet(p, theirs)) continue;
				// Name the file as plainly as either side gives it.
				const file = /[*?]/.test(p) ? theirs : p;
				found.set(file, found.get(file) ?? { agent: other.name, file });
			}
		}
		for (const o of [...found.values()].toSorted((a, b) => (a.file < b.file ? -1 : 1))) {
			out.push({ ...o, ...(other.note ? { starting: other.note.text } : {}) });
		}
	}
	return out;
}

/** The files the agent's unpublished changes touch, in its own view. */
export function draftFiles(host: OverlapHost, agent: AgentState): Set<string> {
	const files = new Set<string>();
	const draft = host.draft(agent);
	// No draft, no view to build: most agents in a big project have nothing unpublished.
	if (draft.length === 0) return files;
	const view = host.agentView(agent);
	for (const id of draft) {
		const atom = host.graph.atom(id);
		for (const run of atom.inserts) files.add(isStartNode(run.parent) ? run.file : view.fileOf(run.parent));
		for (const line of atom.deletes) files.add(view.fileOf(line));
		for (const m of atom.moves ?? []) files.add(view.fileOf(m.line));
	}
	return files;
}

/** Other agents in the agent's space whose unpublished changes or starting note meet `patterns`. */
export function overlaps(host: OverlapHost, agent: AgentState, patterns: readonly string[]): Overlap[] {
	if (patterns.length === 0) return [];
	const peers = [...host.agents.values()]
		.filter((other) => other !== agent && other.space === agent.space)
		.map((other) => ({
			name: other.name,
			files: host.draftFiles(other),
			changesIn: (file: string) => host.draft(other).filter((id) => host.graph.filesOf(id).includes(file)).length,
			note: host.liveNote(other),
		}));
	return overlapsOf(peers, patterns);
}

/**
 * News the first time a draft touches a file someone else in its space has
 * unpublished changes in, or a starting note on (#37): one line per file and agent, once per draft. It tells; it never stops
 * the edit.
 */
export function overlapNews(host: OverlapHost, agent: AgentState, before: ReadonlySet<string>, entries: Entry[]): void {
	const now = host.draftFiles(agent);
	const fresh = [...now].filter((f) => !before.has(f)).toSorted();
	if (fresh.length === 0) return;
	host.queueNews(agent, overlapItems(host.draft(agent)[0] ?? "", overlaps(host, agent, fresh)), entries);
}
