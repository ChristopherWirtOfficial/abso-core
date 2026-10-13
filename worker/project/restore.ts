// Discard unpublished changes to some files, like git restore. Writes go through RestoreHost;
// today the host is Project.

import type { AtomId, Graph, Hunk, ReadView } from "../../src/engine/index.ts";
import { checkReadPath } from "./path-rules.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Blobs, Entry, Files, Meta, Mode, Modes, RestoreAnswer } from "./project-types.ts";

/** What restoring unpublished files needs from a project. */
export interface RestoreHost {
	readonly graph: Graph;
	agent(name: string, entries: Entry[]): AgentState;
	draft(agent: AgentState): AtomId[];
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
	apply(entry: Entry): void;
	view(set: ReadonlySet<AtomId>): ReadView;
	agentSet(agent: AgentState): Set<AtomId>;
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
	flush(entries: Entry[]): void;
}

/**
 * Discard the agent's unpublished changes to some files (all of them with
 * `files` null), like git restore. Changes that touch only those files and
 * that no kept change builds on leave the draft; anything left over is
 * undone by a new change that puts the files back. Answers with each
 * file's text now, for the folder.
 */
export function restore(
	host: RestoreHost,
	agentName: string,
	files: readonly string[] | null,
	time: number,
): RestoreAnswer {
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const draft = host.draft(agent);
	const touched = host.touchedFiles(draft, [host.agentView(agent)]);
	if (files !== null && !Array.isArray(files))
		throw new ProjectError("bad-request", "restore needs {files: [path]} or {all: true}");
	for (const path of files ?? []) checkReadPath(path);
	const targets = new Set(files ?? touched);
	// Drop what touches only the targets, unless a change that stays builds on it.
	const drop = new Set(draft.filter((id) => host.graph.filesOf(id).every((f) => targets.has(f))));
	const kept = draft.filter((id) => !drop.has(id));
	for (const id of host.graph.closureOf(kept.length > 0 ? kept : [])) drop.delete(id);
	if (drop.size > 0) {
		const entry: Entry = { type: "discard", agent: agent.name, atoms: draft.filter((id) => drop.has(id)) };
		entries.push(entry);
		host.apply(entry);
	}
	// Whatever is still changed in a target goes back with a new change.
	const now = host.draft(agent);
	const without = new Set(now);
	const original = host.view(new Set([...host.agentSet(agent)].filter((id) => !without.has(id))));
	for (const path of [...targets].toSorted()) {
		if (!touched.has(path)) continue;
		const was = original.attrs(path);
		host.recordFile(
			agent,
			host.agentView(agent),
			path,
			original.hasFile(path) ? original.text(path) : null,
			time,
			{},
			entries,
			{ exec: was.exec, link: was.link },
			was.blob ?? undefined,
		);
	}
	const view = host.agentView(agent);
	const out: Files = {};
	const modes: Modes = {};
	const blobs: Blobs = {};
	for (const path of [...targets].filter((p) => touched.has(p)).toSorted()) {
		const a = view.attrs(path);
		if (a.blob !== null) blobs[path] = a.blob;
		else out[path] = view.hasFile(path) ? view.text(path) : null;
		if (a.exec || a.link !== null) modes[path] = { exec: a.exec, link: a.link };
	}
	host.flush(entries);
	return {
		files: out,
		dropped: drop.size,
		...(Object.keys(modes).length > 0 ? { modes } : {}),
		...(Object.keys(blobs).length > 0 ? { blobs } : {}),
	};
}
