// Files kept whole (#46): avcs.json's `"whole"` globs, text over WHOLE_LIMIT, or a file that is
// already a blob. The project holds the blob store; these helpers decide which texts go there.

import { canonicalText, type View } from "../../src/engine/index.ts";
import { matchesPattern } from "./globs.ts";
import type { ProjectOptions } from "./project-types.ts";

/**
 * Text longer than this is kept whole, like a binary file (#46): no
 * line ids, so a large generated file can't fill memory.
 */
export const WHOLE_LIMIT = 1_000_000;

/** What the whole-file helpers need from a project. */
export interface WholeHost {
	initialized(): boolean;
	sharedView(): View;
	whole: ProjectOptions["whole"];
}

/** avcs.json's `"whole": [globs]`: paths kept whole. From `config` when given (init), else shared's. */
export function wholeRules(host: WholeHost, config?: string): string[] {
	let text = config;
	if (text === undefined) {
		if (!host.initialized()) return [];
		const view = host.sharedView();
		if (!view.hasFile("avcs.json")) return [];
		text = view.text("avcs.json");
	}
	try {
		const whole = (JSON.parse(text) as { whole?: unknown }).whole;
		return Array.isArray(whole) ? whole.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Whether a file is kept whole: its path matches avcs.json's "whole", its
 * text passes WHOLE_LIMIT, or it is already a blob where it's going. The
 * last makes it one-way: a file kept whole stays whole while it exists,
 * even if it shrinks or the rule changes, so it never flips back and forth.
 */
export function isWhole(
	host: WholeHost,
	path: string,
	length: number,
	view: View | undefined,
	rules: readonly string[],
): boolean {
	if (!host.whole) return false;
	return (
		rules.some((p) => matchesPattern(p, path)) ||
		length > WHOLE_LIMIT ||
		(view !== undefined && view.hasFile(path) && view.attrs(path).blob !== null)
	);
}

/** Files and blobs with every whole file's text moved into the blob store. */
export function wholeOut(
	host: WholeHost,
	files: Readonly<Record<string, string | null>>,
	blobs: Readonly<Record<string, string>>,
	view: View | undefined,
	config?: string,
): { files: Record<string, string | null>; blobs: Record<string, string> } {
	const outFiles: Record<string, string | null> = { ...files };
	const outBlobs: Record<string, string> = { ...blobs };
	if (!host.whole) return { files: outFiles, blobs: outBlobs };
	const rules = wholeRules(host, config);
	for (const [path, text] of Object.entries(files)) {
		if (typeof text !== "string" || !isWhole(host, path, text.length, view, rules)) continue;
		outBlobs[path] = host.whole.keep(canonicalText(text));
		delete outFiles[path];
	}
	return { files: outFiles, blobs: outBlobs };
}
