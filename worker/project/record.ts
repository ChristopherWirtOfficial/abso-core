// Whole files as the agent's folder has them. Writes go through RecordHost;
// today the host is Project.

import { canonicalText, type Hunk, type ReadView } from "../../src/engine/index.ts";
import { checkPath } from "./path-rules.ts";
import { isComposed, pathKey } from "./pathkey.ts";
import { ProjectError } from "./project-error.ts";
import type {
	AgentState,
	Entry,
	Files,
	Meta,
	Mode,
	Modes,
	ProjectOptions,
	RecordAnswer,
	Spelling,
} from "./project-types.ts";
import { spellingOf } from "./spelling.ts";
import { checkModes } from "./view-changes.ts";

/** What recording whole files needs from a project. */
export interface RecordHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly whole: ProjectOptions["whole"];
	initialized(): boolean;
	agentView(agent: AgentState): ReadView;
	sharedView(): ReadView;
	wholeOut(
		files: Readonly<Record<string, string | null>>,
		blobs: Readonly<Record<string, string>>,
		view: ReadView | undefined,
		config?: string,
	): { files: Record<string, string | null>; blobs: Record<string, string> };
	checkBlobs(blobs: unknown, files: object): Record<string, string>;
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
	overlapNews(agent: AgentState, before: ReadonlySet<string>, entries: Entry[]): void;
	markedNews(agent: AgentState, files: readonly string[], entries: Entry[]): void;
	newsAboutOwnDraft(agent: AgentState, entries: Entry[]): void;
	takeNews(agent: AgentState, entries: Entry[]): string[];
	flush(entries: Entry[]): void;
}

/**
 * Whole files as the agent's folder has them; each is diffed against its view.
 */
export function record(
	host: RecordHost,
	agentName: string,
	files: Files,
	time: number,
	modes: Modes = {},
	blobs: Readonly<Record<string, string>> = {},
	meta: Meta = {},
	options: { exactSpelling?: boolean } = {},
): RecordAnswer {
	if (typeof files !== "object" || files === null) throw new ProjectError("bad-request", "record needs {files}");
	checkModes(modes);
	// One file whatever the case of its spelling (#49): a second spelling is recorded as the existing one.
	const spelling: Spelling[] = [];
	if (!options.exactSpelling) {
		const known = host.agents.get(agentName);
		const view = known ? host.agentView(known) : host.initialized() ? host.sharedView() : undefined;
		if (view) {
			// A record naming both spellings (the old one gone, the new one written) is a rename, taken as it is.
			const named = new Set([...Object.keys(files), ...Object.keys(modes), ...Object.keys(blobs)]);
			// Both written is two spellings of one new file: refused, naming both.
			const written = new Map<string, string>();
			for (const p of named) {
				if (files[p] === null) continue;
				const other = written.get(pathKey(p));
				if (other !== undefined)
					throw new ProjectError(
						"bad-request",
						`${other} and ${p} are one file, spelled two ways (case or Unicode form); record one of them (#49)`,
					);
				written.set(pathKey(p), p);
			}
			const respell = <T>(o: Readonly<Record<string, T>>): Record<string, T> => {
				const out: Record<string, T> = {};
				for (const [path, v] of Object.entries(o)) {
					const twin = spellingOf(view, path);
					const existing = named.has(twin) ? path : twin;
					if (existing !== path && !spelling.some((s) => s.path === path)) spelling.push({ path, existing });
					out[existing] = v;
				}
				return out;
			};
			files = respell(files);
			modes = respell(modes);
			blobs = respell(blobs);
		}
	}
	if (host.whole) {
		const known = host.agents.get(agentName);
		({ files, blobs } = host.wholeOut(files, blobs, known ? host.agentView(known) : host.sharedView()));
	}
	host.checkBlobs(blobs, files);
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const touched = host.draftFiles(agent);
	const changed: string[] = [];
	// The view before: asked only about the recorded paths, so no other file is laid out (#46).
	const before = host.agentView(agent);
	for (const path of [...new Set([...Object.keys(files), ...Object.keys(modes), ...Object.keys(blobs)])].toSorted()) {
		// A file with a non-canonical path from before #30 can still be removed.
		const removing =
			files[path] === null &&
			modes[path] === undefined &&
			blobs[path] === undefined &&
			host.agentView(agent).hasFile(path);
		if (!removing) checkPath(path);
		const text = files[path];
		if (text !== undefined && text !== null && typeof text !== "string")
			throw new ProjectError("bad-request", `${path}: text or null`);
		const view = host.agentView(agent);
		const blob = blobs[path];
		const target =
			blob !== undefined ? "" : text === undefined ? undefined : text === null ? null : canonicalText(text);
		// The session and subagent, when the edit hook sent the file whole (#37: they were dropped, so a hook record read as a command's).
		if (host.recordFile(agent, view, path, target, time, meta, entries, modes[path], blob)) changed.push(path);
	}
	host.overlapNews(agent, touched, entries);
	host.markedNews(agent, changed, entries);
	host.newsAboutOwnDraft(agent, entries);
	const news = host.takeNews(agent, entries);
	host.flush(entries);
	const uncomposed = changed.filter((p) => !isComposed(p) && !before.hasFile(p));
	return {
		ok: true,
		changed,
		news,
		...(spelling.length > 0 ? { spelling } : {}),
		...(uncomposed.length > 0 ? { uncomposed } : {}),
	};
}
