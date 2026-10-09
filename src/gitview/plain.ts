// Git-view helpers that need no git library, so the pre-receive hook (which
// reads git through the git CLI) can use them without loading isomorphic-git.
// tree.ts and ingest.ts re-export them.

import { type AtomId, type AtomSet, canonicalText, type Graph, type Hunk, sortBySeq } from "../engine/index.ts";

// fatal: invalid UTF-8 throws (so the file counts as binary); ignoreBOM: a BOM
// stays in the text, so the file round-trips byte for byte.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A blob's text in canonical form, or why it isn't a text file. */
export function decodeBlob(bytes: Uint8Array): { text: string } | { reason: "empty" | "binary" } {
	if (bytes.length === 0) return { reason: "empty" };
	if (bytes.subarray(0, 8000).includes(0)) return { reason: "binary" };
	let text: string;
	try {
		text = UTF8.decode(bytes);
	} catch {
		return { reason: "binary" };
	}
	return { text: canonicalText(text) };
}

/** Maximal atoms of a closed set: those no atom in the set depends on. By seq. */
export function headsOf(graph: Graph, set: AtomSet): AtomId[] {
	const out: AtomId[] = [];
	for (const id of set) if (!graph.dependentsOf(id).some((d) => set.has(d))) out.push(id);
	return sortBySeq(graph, out);
}

/** "git-<short sha>", lengthened while another label has the name. */
export function labelName(graph: Graph, sha: string): string {
	for (let n = 7; n <= sha.length; n++) {
		const name = `git-${sha.slice(0, n)}`;
		if (!graph.label(name)) return name;
	}
	for (let i = 2; ; i++) {
		const name = `git-${sha}-${i}`;
		if (!graph.label(name)) return name;
	}
}

/** Where a hunk is, the way git prints it: "path @@ -old,count +new,count @@" (1-based). */
export function hunkLocation(path: string, hunk: Hunk, shift: number): string {
	const oldCount = hunk.end - hunk.start;
	const newCount = hunk.lines.length;
	const newStart = hunk.start + shift;
	const o = oldCount === 0 ? hunk.start : hunk.start + 1;
	const n = newCount === 0 ? newStart : newStart + 1;
	return `${path} @@ -${o},${oldCount} +${n},${newCount} @@`;
}
