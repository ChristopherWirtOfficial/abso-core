// Move a file in the agent's draft. Writes go through MoveHost; today the
// host is Project.

import type { EditInput, Hunk, MoveInput, ReadView } from "../../src/engine/index.ts";
import { checkPath } from "./path-rules.ts";
import { pathKey } from "./pathkey.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Entry, Meta, Mode } from "./project-types.ts";

/** What a file move needs from a project. */
export interface MoveHost {
	needInit(): void;
	readonly agents: ReadonlyMap<string, AgentState>;
	agentView(agent: AgentState): ReadView;
	sharedView(): ReadView;
	agent(name: string, entries: Entry[]): AgentState;
	addDraft(
		agent: AgentState,
		view: ReadView,
		input: { edits: readonly EditInput[]; move?: MoveInput },
		time: number,
		meta: Meta,
		entries: Entry[],
	): void;
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
	newsAboutOwnDraft(agent: AgentState, entries: Entry[]): void;
	takeNews(agent: AgentState, entries: Entry[]): string[];
	flush(entries: Entry[]): void;
}

/**
 * Move a file in the agent's draft (#49): its lines keep their ids, as with
 * git mv, so blame and why follow it. The only way to change a file's case.
 * Refused when `to` is another existing file, ignoring case.
 */
export function move(
	host: MoveHost,
	agentName: string,
	from: string,
	to: string,
	time: number,
): { ok: true; from: string; to: string; news: string[] } {
	host.needInit();
	if (typeof from !== "string" || typeof to !== "string")
		throw new ProjectError("bad-request", "move needs {from, to}");
	checkPath(from);
	checkPath(to);
	const known = host.agents.get(agentName);
	const before = known ? host.agentView(known) : host.sharedView();
	if (!before.hasFile(from)) throw new ProjectError("not-found", `there is no ${from} to move`);
	if (from === to) throw new ProjectError("bad-request", `${from} is already called that`);
	const taken = before.paths().find((p) => p !== from && pathKey(p) === pathKey(to));
	if (taken)
		throw new ProjectError(
			"conflict",
			`${to} is ${taken}, another file (spellings that differ only in case or Unicode form are one file)`,
		);
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const view = host.agentView(agent);
	const attrs = view.attrs(from);
	const lines = view.lines(from).length;
	const mode: Mode = { exec: attrs.exec, link: attrs.link };
	if (lines > 0 && attrs.blob === null) {
		const text = view.text(from);
		host.addDraft(agent, view, { edits: [], move: { file: from, start: 0, end: lines, to, at: 0 } }, time, {}, entries);
		host.recordFile(agent, host.agentView(agent), to, text, time, {}, entries, mode);
	} else {
		// A binary or empty file has no lines to carry: the new name takes its blob and modes.
		host.recordFile(agent, host.agentView(agent), to, "", time, {}, entries, mode, attrs.blob ?? undefined);
	}
	host.recordFile(agent, host.agentView(agent), from, null, time, {}, entries);
	host.newsAboutOwnDraft(agent, entries);
	const news = host.takeNews(agent, entries);
	host.flush(entries);
	return { ok: true, from, to, news };
}
