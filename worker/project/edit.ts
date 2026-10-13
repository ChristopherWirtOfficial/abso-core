// An Edit, Write or MultiEdit from the hook. Writes go through EditHost; today
// the host is Project.

import {
	canonicalText,
	type EditInput,
	EngineError,
	type Hunk,
	normalizeText,
	type ReadView,
} from "../../src/engine/index.ts";
import { checkPath } from "./path-rules.ts";
import { isComposed } from "./pathkey.ts";
import { ProjectError } from "./project-error.ts";
import { replaceOnce } from "./project-helpers.ts";
import type {
	AgentState,
	EditAnswer,
	EditBody,
	Entry,
	Files,
	Meta,
	Mode,
	Modes,
	ProjectOptions,
	RecordAnswer,
} from "./project-types.ts";
import { spellingOf } from "./spelling.ts";

/** What an edit needs from a project. */
export interface EditHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly whole: ProjectOptions["whole"];
	initialized(): boolean;
	agentView(agent: AgentState): ReadView;
	sharedView(): ReadView;
	isWhole(path: string, length: number, view: ReadView | undefined, rules: readonly string[]): boolean;
	wholeRules(config?: string): string[];
	record(
		agentName: string,
		files: Files,
		time: number,
		modes?: Modes,
		blobs?: Readonly<Record<string, string>>,
		meta?: Meta,
	): RecordAnswer;
	agent(name: string, entries: Entry[]): AgentState;
	draftFiles(agent: AgentState): Set<string>;
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
	addDraft(
		agent: AgentState,
		view: ReadView,
		input: { edits: readonly EditInput[] },
		time: number,
		meta: Meta,
		entries: Entry[],
	): void;
	overlapNews(agent: AgentState, before: ReadonlySet<string>, entries: Entry[]): void;
	markedNews(agent: AgentState, files: readonly string[], entries: Entry[]): void;
	newsAboutOwnDraft(agent: AgentState, entries: Entry[]): void;
	takeNews(agent: AgentState, entries: Entry[]): string[];
	flush(entries: Entry[]): void;
}

/** An Edit, Write or MultiEdit from the hook, against the agent's view. */
export function edit(host: EditHost, agentName: string, body: EditBody, time: number): EditAnswer {
	if (typeof body !== "object" || body === null || typeof body.file !== "string") {
		throw new ProjectError("bad-request", "edit needs a file");
	}
	// A new name not in composed form gets a gentle warning (#49).
	const known = host.agents.get(agentName);
	const view = known ? host.agentView(known) : host.initialized() ? host.sharedView() : undefined;
	const fresh =
		!isComposed(body.file) && !!view && spellingOf(view, body.file) === body.file && !view.hasFile(body.file);
	const answer = editInner(host, agentName, body, time);
	return fresh && answer.ok ? { ...answer, uncomposed: [body.file] } : answer;
}

function outOfStep(host: EditHost, entries: Entry[]): EditAnswer {
	host.flush(entries);
	return { ok: false, reason: "out of step" };
}

function editInner(host: EditHost, agentName: string, body: EditBody, time: number): EditAnswer {
	checkPath(body.file);
	{
		// One file whatever the case of its spelling (#49).
		const known = host.agents.get(agentName);
		const view = known ? host.agentView(known) : host.initialized() ? host.sharedView() : undefined;
		const existing = view ? spellingOf(view, body.file) : body.file;
		if (existing !== body.file) {
			const answer = edit(host, agentName, { ...body, file: existing }, time);
			return answer.ok ? { ...answer, spelling: [{ path: body.file, existing }] } : answer;
		}
	}
	if (host.whole) {
		// A whole file has no lines to edit (#46): a Write records it; an Edit is out of step, so the client sends the file.
		const known = host.agents.get(agentName);
		const content = "content" in body && typeof body.content === "string" ? body.content : undefined;
		if (
			host.isWhole(
				body.file,
				content?.length ?? 0,
				known ? host.agentView(known) : host.sharedView(),
				host.wholeRules(),
			)
		) {
			if (content === undefined) return { ok: false, reason: "out of step" };
			const meta = { session: body.session, subagent: body.subagent, client: body.client };
			return { ok: true, news: host.record(agentName, { [body.file]: content }, time, {}, {}, meta).news };
		}
	}
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const touched = host.draftFiles(agent);
	const view = host.agentView(agent);
	const current = view.text(body.file);
	const meta = { session: body.session, subagent: body.subagent, client: body.client };

	if ("content" in body) {
		if (typeof body.content !== "string") throw new ProjectError("bad-request", "content must be a string");
		host.recordFile(agent, view, body.file, canonicalText(body.content), time, meta, entries);
	} else if ("edits" in body) {
		if (!Array.isArray(body.edits)) throw new ProjectError("bad-request", "edits must be a list");
		let text = current;
		for (const e of body.edits) {
			const next = replaceOnce(text, e?.old, e?.new);
			if (next === undefined) return outOfStep(host, entries);
			text = next;
		}
		host.recordFile(agent, view, body.file, canonicalText(text), time, meta, entries);
	} else {
		if (typeof body.old !== "string" || typeof body.new !== "string") {
			throw new ProjectError("bad-request", "an edit needs old and new strings");
		}
		if (replaceOnce(current, body.old, body.new) === undefined) return outOfStep(host, entries);
		if (normalizeText(body.old) !== normalizeText(body.new)) {
			try {
				host.addDraft(agent, view, { edits: [{ file: body.file, old: body.old, new: body.new }] }, time, meta, entries);
			} catch (err) {
				if (!(err instanceof EngineError) || err.code !== "empty-atom") throw err;
			}
		}
	}
	host.overlapNews(agent, touched, entries);
	host.markedNews(agent, [body.file], entries);
	host.newsAboutOwnDraft(agent, entries);
	const news = host.takeNews(agent, entries);
	host.flush(entries);
	return { ok: true, news };
}
