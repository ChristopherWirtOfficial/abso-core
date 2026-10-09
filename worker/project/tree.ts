// A tree hash (#39, the merge queue; #42, Actions): one sha256 for a set of
// files, so a queue candidate and the version that lands from it, or a run in
// someone's own account, can be matched without comparing every file. It
// covers each file's path, mode (executable, or link target) and content (the
// text's sha256, or the blob's sha256 for a binary file), in path order.
import { createHash } from "node:crypto";

export interface TreeFiles {
	readonly files: Readonly<Record<string, string>>;
	readonly modes?: Readonly<Record<string, { readonly exec?: boolean; readonly link?: string | null }>>;
	readonly blobs?: Readonly<Record<string, string>>;
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function treeHash(tree: TreeFiles): string {
	const paths = [...new Set([...Object.keys(tree.files), ...Object.keys(tree.blobs ?? {})])].sort();
	const lines = paths.map((p) => {
		const m = tree.modes?.[p];
		const mode = m?.link != null ? `link:${m.link}` : m?.exec ? "exec" : "file";
		const content = tree.blobs?.[p] ?? sha(tree.files[p] ?? "");
		return `${mode} ${content} ${p}`;
	});
	return sha(lines.join("\n"));
}
