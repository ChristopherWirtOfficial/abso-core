// Make one file in the agent's view what the folder has. Writes go through
// RecordFileHost; today the host is Project.

import {
	type AttrName,
	type AttrSet,
	diffChunkedLines,
	type EditInput,
	type Hunk,
	type ReadView,
	type SpliceEdit,
	splitLines,
} from "../../src/engine/index.ts";
import type { AgentState, Entry, Meta, Mode } from "./project-types.ts";

/** What recording one file needs from a project. */
export interface RecordFileHost {
	addDraft(
		agent: AgentState,
		view: ReadView,
		input: { edits: readonly EditInput[]; attrs?: readonly AttrSet[] },
		time: number,
		meta: Meta,
		entries: Entry[],
	): void;
}

/**
 * Make one file in the agent's view what the folder has, as one draft
 * change: `text` (null: the file is gone; "": an empty file; undefined:
 * leave its lines alone) and `mode` (only the fields given). Returns
 * whether anything changed.
 */
export function recordFile(
	host: RecordFileHost,
	agent: AgentState,
	view: ReadView,
	path: string,
	text: string | null | undefined,
	time: number,
	meta: Meta,
	entries: Entry[],
	mode: Mode = {},
	blob?: string,
	hunks?: readonly Hunk[],
): boolean {
	const lines = text === undefined ? undefined : text === null ? "" : text;
	const edits: SpliceEdit[] =
		lines === undefined || (hunks !== undefined && sameProjectedText(view, path, lines))
			? []
			: (hunks ?? diffChunkedLines(view.lineChunks(path), splitLines(lines))).map((h) => ({
					file: path,
					start: h.start,
					end: h.end,
					lines: h.lines,
				}));
	return recordFileChanges(
		host,
		agent,
		view,
		path,
		text === undefined ? "unchanged" : text === null ? "missing" : text === "" ? "empty" : "present",
		edits,
		time,
		meta,
		entries,
		mode,
		blob,
	);
}

/** Apply a precomputed exact text diff and the normal file attribute rules. */
export function recordFileChanges(
	host: RecordFileHost,
	agent: AgentState,
	view: ReadView,
	path: string,
	state: "unchanged" | "missing" | "empty" | "present",
	edits: readonly SpliceEdit[],
	time: number,
	meta: Meta,
	entries: Entry[],
	mode: Mode = {},
	blob?: string,
): boolean {
	const was = view.attrs(path);
	const exists = view.hasFile(path);

	const attrs: AttrSet[] = [];
	const set = (name: AttrName, now: string | null, value: string | null): void => {
		if (now !== value) attrs.push({ file: path, name, value });
	};
	const link = mode.link !== undefined ? mode.link : state === "missing" ? null : was.link;
	if (state === "missing") {
		// Gone: no lines, and nothing keeps it.
		set("exists", was.exists ? "1" : null, null);
		set("exec", was.exec ? "1" : null, null);
	} else if (state === "empty" && link === null && blob === undefined) {
		// An empty file is kept by its exists attribute.
		set("exists", was.exists ? "1" : null, "1");
	}
	// A binary file is its blob and no lines; text, or no file, clears the blob.
	if (blob !== undefined) set("blob", was.blob, blob);
	else if (state !== "unchanged") set("blob", was.blob, null);
	if (mode.exec !== undefined && state !== "missing") set("exec", was.exec ? "1" : null, mode.exec ? "1" : null);
	set("link", was.link, link);
	if (edits.length === 0 && attrs.length === 0) return false;
	if (!exists && state === "missing" && attrs.length === 0) return false;
	host.addDraft(agent, view, { edits, attrs }, time, meta, entries);
	return true;
}

/** Compare canonical projected text without joining or caching old lines. */
function sameProjectedText(view: ReadView, path: string, text: string): boolean {
	let offset = 0;
	for (const line of view.visibleLines(path)) {
		if (!text.startsWith(line.text, offset)) return false;
		offset += line.text.length;
		if (text[offset++] !== "\n") return false;
	}
	return offset === text.length;
}
