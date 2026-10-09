// Say what an agent is starting on, before any edit lands. Writes go through
// StartingHost; today the host is Project.

import { type NewsItem, startingItem } from "./news.ts";
import { notePatterns } from "./overlaps.ts";
import { checkPath } from "./path-rules.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, ChangeRecord, Entry, IssueHook, Overlap, Starting } from "./project-types.ts";

/** What recording a start note needs from a project. */
export interface StartingHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly changes: ReadonlyMap<number, ChangeRecord>;
	agent(name: string, entries: Entry[]): AgentState;
	liveNote(agent: AgentState): Starting | undefined;
	apply(entry: Entry): void;
	overlaps(agent: AgentState, patterns: readonly string[]): Overlap[];
	queueNews(agent: AgentState, items: readonly NewsItem[], entries: Entry[]): void;
	flush(entries: Entry[]): void;
}

/**
 * Say what the agent is starting on (#37, #13), before any edit lands:
 * `text`, and the files it expects to change if it knows them. Nothing is
 * locked or refused. where and status show it until the agent publishes,
 * lands, or sends null. The answer names who already has unpublished
 * changes in, or a starting note on, those files; they hear of it too.
 */
export function starting(
	host: StartingHost,
	agentName: string,
	text: string | null,
	files: readonly string[] | undefined,
	time: number,
	options: { issue?: unknown; done?: unknown } = {},
): { starting: Starting | null; overlaps: Overlap[]; hooks?: { claim?: IssueHook; unclaim?: IssueHook } } {
	const issue = options.issue;
	if (issue !== undefined && (!Number.isInteger(issue) || (issue as number) < 1))
		throw new ProjectError("bad-request", "issue is an issue number");
	if (issue !== undefined && text === null)
		throw new ProjectError("bad-request", "an issue goes with a start note, not a take-back");
	if (options.done !== undefined && options.done !== true)
		throw new ProjectError("bad-request", "done is true or left out");
	if (options.done === true && text !== null)
		throw new ProjectError("bad-request", "done goes with a take-back ({text: null})");
	if (text !== null && (typeof text !== "string" || text.trim() === ""))
		throw new ProjectError("bad-request", "starting needs {text}, or {text: null} to take it back");
	if (typeof text === "string" && text.length > 1000)
		throw new ProjectError("bad-request", "a starting note is at most 1000 characters");
	if (files !== undefined && (!Array.isArray(files) || !files.every((f) => typeof f === "string"))) {
		throw new ProjectError("bad-request", "files must be a list of paths");
	}
	if ((files?.length ?? 0) > 100) throw new ProjectError("bad-request", "a starting note names at most 100 files");
	// Files a note names may be globs (#37): only the shape of a path is checked, not what a disk can hold.
	for (const f of files ?? []) checkPath(f.replace(/[*?]/g, "x"));
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const named = [...new Set(files ?? [])].toSorted();
	// The note this one ends, if it named an issue (#54): its issue is no longer claimed by it.
	const ending = host.liveNote(agent);
	const endingAt = agent.noteAt;
	const entry: Entry = {
		type: "starting",
		agent: agent.name,
		text: text === null ? null : text.trim(),
		...(text !== null && named.length > 0 ? { files: named } : {}),
		time,
		...(issue !== undefined ? { issue: issue as number } : {}),
		...(options.done === true ? { done: true as const } : {}),
	};
	entries.push(entry);
	host.apply(entry);
	const hooks: { claim?: IssueHook; unclaim?: IssueHook } = {};
	if (ending?.issue !== undefined && endingAt !== undefined) {
		// done names the change's newest version of shared, the one that finished the work.
		const version = host.changes
			.get(endingAt)
			?.versions.filter((v) => v.draft === null)
			.at(-1)?.version;
		hooks.unclaim = {
			issue: ending.issue,
			agent: agent.name,
			change: endingAt,
			done: options.done === true,
			...(version !== undefined ? { version } : {}),
		};
	}
	if (issue !== undefined && agent.noteAt !== undefined)
		hooks.claim = { issue: issue as number, agent: agent.name, change: agent.noteAt };
	// Files named by glob, and paths written in the text, count too (#37, Builder 4).
	const overlaps = text === null ? [] : host.overlaps(agent, notePatterns(host.liveNote(agent)));
	for (const name of [...new Set(overlaps.map((o) => o.agent))]) {
		const mine = overlaps.filter((o) => o.agent === name).map((o) => o.file);
		host.queueNews(host.agents.get(name)!, [startingItem(agent.name, time, name, text!, mine)], entries);
	}
	host.flush(entries);
	const note = host.liveNote(agent);
	// hooks only when the Issues Worker has something to hear; the Worker takes them off the answer.
	return {
		starting: note ? { ...note, files: [...note.files] } : null,
		overlaps,
		...(hooks.claim || hooks.unclaim ? { hooks } : {}),
	};
}
