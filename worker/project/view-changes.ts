import { createHash } from "node:crypto";
import type { ReadView } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type { FileChange, Mode, Modes } from "./project-types.ts";

/** The listed files whose text differs between two views, before and after. */
export function changesBetween(before: ReadView, after: ReadView, files: Iterable<string>): FileChange[] {
	const out: FileChange[] = [];
	for (const path of [...new Set(files)].toSorted()) {
		const b = before.hasFile(path) ? before.text(path) : null;
		const a = after.hasFile(path) ? after.text(path) : null;
		const mode = modeChange(before, after, path);
		const bb = before.attrs(path).blob;
		const ab = after.attrs(path).blob;
		const blob = bb !== ab ? { before: bb, after: ab } : undefined;
		if (a !== b || mode || blob)
			out.push({ path, before: b, after: a, ...(mode ? { mode } : {}), ...(blob ? { blob } : {}) });
	}
	return out;
}

/** A changed file's text or blob, summed up: its size in UTF-8 bytes and its SHA-256, or a blob's hash. */
export type FileSummary = { size: number; sha256: string } | { blob: string };

/**
 * changesBetween without the texts (abso issue 680, compare's summary): each changed file before and after as its size
 * and SHA-256, or its blob's hash for a binary file. Each text is read, summed up and let go, so a compare of thousands
 * of files never holds them all.
 */
export function summariesBetween(
	before: ReadView,
	after: ReadView,
	files: Iterable<string>,
): {
	path: string;
	before: FileSummary | null;
	after: FileSummary | null;
	mode?: { before: Mode; after: Mode };
	blob?: { before: string | null; after: string | null };
}[] {
	const sum = (view: ReadView, path: string): FileSummary | null => {
		if (!view.hasFile(path)) return null;
		const blob = view.attrs(path).blob;
		if (blob !== null) return { blob };
		const text = view.text(path);
		return { size: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
	};
	const out: ReturnType<typeof summariesBetween> = [];
	for (const path of [...new Set(files)].toSorted()) {
		if (!differs(before, after, path)) continue;
		const mode = modeChange(before, after, path);
		const bb = before.attrs(path).blob;
		const ab = after.attrs(path).blob;
		out.push({
			path,
			before: sum(before, path),
			after: sum(after, path),
			...(mode ? { mode } : {}),
			...(bb !== ab ? { blob: { before: bb, after: ab } } : {}),
		});
	}
	return out;
}

/** Whether a file differs between two views: its text, its mode, or its blob (what changesBetween lists). */
export function differs(before: ReadView, after: ReadView, path: string): boolean {
	const had = before.hasFile(path);
	if (had !== after.hasFile(path)) return true;
	if (had && !before.sameText(path, after)) return true;
	const b = before.attrs(path);
	const a = after.attrs(path);
	return b.exec !== a.exec || b.link !== a.link || b.blob !== a.blob;
}

/** A file's executable bit and link target, before and after, when either changed. */
export function modeChange(before: ReadView, after: ReadView, path: string): { before: Mode; after: Mode } | undefined {
	const b = before.attrs(path);
	const a = after.attrs(path);
	if (b.exec === a.exec && b.link === a.link) return undefined;
	return { before: { exec: b.exec, link: b.link }, after: { exec: a.exec, link: a.link } };
}

/** Every executable file and link in a view. */
export function modesOf(view: ReadView): Modes {
	const out: Modes = {};
	for (const path of view.paths()) {
		const a = view.attrs(path);
		if (a.exec || a.link !== null)
			out[path] = { ...(a.exec ? { exec: true } : {}), ...(a.link !== null ? { link: a.link } : {}) };
	}
	return out;
}

export function checkModes(modes: unknown): Modes {
	if (typeof modes !== "object" || modes === null || Array.isArray(modes))
		throw new ProjectError("bad-request", "modes must be {path: {exec, link}}");
	for (const [path, m] of Object.entries(modes as Record<string, unknown>)) {
		const mode = m as Mode;
		if (typeof m !== "object" || m === null) throw new ProjectError("bad-request", `${path}: a mode is {exec?, link?}`);
		if (mode.exec !== undefined && typeof mode.exec !== "boolean")
			throw new ProjectError("bad-request", `${path}: exec is true or false`);
		if (
			mode.link !== undefined &&
			mode.link !== null &&
			(typeof mode.link !== "string" || mode.link === "" || /[\n\r]/.test(mode.link))
		) {
			throw new ProjectError("bad-request", `${path}: link is a target path or null`);
		}
	}
	return modes as Modes;
}
