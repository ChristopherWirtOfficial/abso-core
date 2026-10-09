// Make one file in the agent's view what the folder has. Writes go through
// RecordFileHost; today the host is Project.

import {
	type AttrName,
	type AttrSet,
	diffLines,
	type EditInput,
	type Hunk,
	type SpliceEdit,
	splitLines,
	type View,
} from "../../src/engine/index.ts";
import type { AgentState, Entry, Meta, Mode } from "./project-types.ts";

/** What recording one file needs from a project. */
export interface RecordFileHost {
	addDraft(
		agent: AgentState,
		view: View,
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
	view: View,
	path: string,
	text: string | null | undefined,
	time: number,
	meta: Meta,
	entries: Entry[],
	mode: Mode = {},
	blob?: string,
	hunks?: readonly Hunk[],
): boolean {
	const was = view.attrs(path);
	const exists = view.hasFile(path);
	const lines = text === undefined ? undefined : text === null ? "" : text;
	const edits: SpliceEdit[] =
		lines === undefined || view.text(path) === lines
			? []
			: (
					hunks ??
					diffLines(
						view.lines(path).map((l) => l.text),
						splitLines(lines),
					)
				).map((h) => ({ file: path, start: h.start, end: h.end, lines: h.lines }));
	const attrs: AttrSet[] = [];
	const set = (name: AttrName, now: string | null, value: string | null): void => {
		if (now !== value) attrs.push({ file: path, name, value });
	};
	const link = mode.link !== undefined ? mode.link : text === null ? null : was.link;
	if (text === null) {
		// Gone: no lines, and nothing keeps it.
		set("exists", was.exists ? "1" : null, null);
		set("exec", was.exec ? "1" : null, null);
	} else if (text === "" && link === null && blob === undefined) {
		// An empty file is kept by its exists attribute.
		set("exists", was.exists ? "1" : null, "1");
	}
	// A binary file is its blob and no lines; text, or no file, clears the blob.
	if (blob !== undefined) set("blob", was.blob, blob);
	else if (text !== undefined) set("blob", was.blob, null);
	if (mode.exec !== undefined && text !== null) set("exec", was.exec ? "1" : null, mode.exec ? "1" : null);
	set("link", was.link, link);
	if (edits.length === 0 && attrs.length === 0) return false;
	if (!exists && text === null && attrs.length === 0) return false;
	host.addDraft(agent, view, { edits, attrs }, time, meta, entries);
	return true;
}
