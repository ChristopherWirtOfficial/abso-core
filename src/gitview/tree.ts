// Git trees as plain files (path -> text), read and written with
// isomorphic-git. Only text files can be made of atoms' lines; every other
// tree entry is listed as skipped with the reason.

import fs from "node:fs";
import { readBlob, readTree, type TreeEntry, writeBlob, writeTree } from "isomorphic-git";
import { GitViewError } from "./errors.ts";
import { decodeBlob } from "./plain.ts";

/** What every isomorphic-git call here needs: the file system, the repo, and a shared object cache. */
export interface GitContext {
	readonly fs: typeof fs;
	readonly dir: string;
	/** isomorphic-git's cache for parsed objects; reuse one per repo per operation. */
	readonly cache: object;
}

export function gitContext(dir: string): GitContext {
	return { fs, dir, cache: {} };
}

/** Why a tree entry is not a text file of the projection. */
export type SkipReason =
	/** 0 bytes: a file exists in a projection only while it has a line. */
	| "empty"
	/** A NUL byte in the first 8000 bytes (git's own test), or not valid UTF-8. */
	| "binary"
	| "symlink"
	| "submodule"
	/** A path the engine can't hold (it has a line break in it). */
	| "unsupported-path";

export interface SkippedEntry {
	readonly path: string;
	readonly reason: SkipReason;
	/** The blob (or submodule commit) id, so a caller can tell when it changed. */
	readonly oid: string;
}

export interface TreeFiles {
	/** Text files, path -> canonical text ("\n" line endings, a final newline). */
	readonly files: Map<string, string>;
	readonly skipped: SkippedEntry[];
}

const MODE_TREE = "040000";
const MODE_FILE = "100644";
const MODE_LINK = "120000";
const MODE_SUBMODULE = "160000";

const ENCODE = new TextEncoder();

export { decodeBlob };

/** Every file of a tree, recursively. Paths use "/". */
export async function readTreeFiles(ctx: GitContext, treeOid: string): Promise<TreeFiles> {
	const files = new Map<string, string>();
	const skipped: SkippedEntry[] = [];
	const visit = async (oid: string, prefix: string): Promise<void> => {
		const { tree } = await readTree({ fs: ctx.fs, dir: ctx.dir, oid, cache: ctx.cache });
		for (const entry of tree) {
			const path = prefix + entry.path;
			if (entry.mode === MODE_TREE) {
				await visit(entry.oid, `${path}/`);
			} else if (entry.mode === MODE_SUBMODULE) {
				skipped.push({ path, reason: "submodule", oid: entry.oid });
			} else if (entry.mode === MODE_LINK) {
				skipped.push({ path, reason: "symlink", oid: entry.oid });
			} else if (/[\n\r]/.test(path)) {
				skipped.push({ path, reason: "unsupported-path", oid: entry.oid });
			} else {
				const { blob } = await readBlob({ fs: ctx.fs, dir: ctx.dir, oid: entry.oid, cache: ctx.cache });
				const decoded = decodeBlob(blob);
				if ("text" in decoded) files.set(path, decoded.text);
				else skipped.push({ path, reason: decoded.reason, oid: entry.oid });
			}
		}
	};
	await visit(treeOid, "");
	skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { files, skipped };
}

/** Object ids already written in this repo, so repeated trees and blobs are hashed once. */
export interface WriteCache {
	readonly blobs: Map<string, string>;
	readonly trees: Map<string, string>;
}

export function writeCache(): WriteCache {
	return { blobs: new Map(), trees: new Map() };
}

interface DirNode {
	readonly files: Map<string, string>;
	readonly dirs: Map<string, DirNode>;
}

/**
 * Write files (path -> text) as a git tree and return its id. Every file is a
 * plain 100644 blob. Throws `bad-path` for a path git can't hold: an empty
 * part, ".", "..", ".git", or a name that is both a file and a directory.
 */
export async function writeFilesTree(
	ctx: GitContext,
	files: Readonly<Record<string, string>>,
	cache: WriteCache,
): Promise<string> {
	const root: DirNode = { files: new Map(), dirs: new Map() };
	for (const path of Object.keys(files).sort()) {
		const parts = path.split("/");
		for (const part of parts) {
			if (part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes("\0")) {
				throw new GitViewError("bad-path", `${JSON.stringify(path)} can't be a path in a git tree`);
			}
		}
		let node = root;
		for (const part of parts.slice(0, -1)) {
			if (node.files.has(part)) throw new GitViewError("bad-path", `${path}: ${part} is both a file and a directory`);
			let next = node.dirs.get(part);
			if (!next) {
				next = { files: new Map(), dirs: new Map() };
				node.dirs.set(part, next);
			}
			node = next;
		}
		const name = parts[parts.length - 1]!;
		if (node.dirs.has(name)) throw new GitViewError("bad-path", `${path} is both a file and a directory`);
		node.files.set(name, files[path]!);
	}
	return writeDir(ctx, root, cache);
}

async function writeDir(ctx: GitContext, node: DirNode, cache: WriteCache): Promise<string> {
	const entries: TreeEntry[] = [];
	for (const [name, text] of node.files) {
		let oid = cache.blobs.get(text);
		if (oid === undefined) {
			oid = await writeBlob({ fs: ctx.fs, dir: ctx.dir, blob: ENCODE.encode(text) });
			cache.blobs.set(text, oid);
		}
		entries.push({ mode: MODE_FILE, path: name, oid, type: "blob" });
	}
	for (const [name, child] of node.dirs) {
		entries.push({ mode: MODE_TREE, path: name, oid: await writeDir(ctx, child, cache), type: "tree" });
	}
	// isomorphic-git sorts entries the way git does; the key only needs to be stable.
	const key = entries
		.map((e) => `${e.mode} ${e.oid} ${e.path}`)
		.sort()
		.join("\n");
	let oid = cache.trees.get(key);
	if (oid === undefined) {
		oid = await writeTree({ fs: ctx.fs, dir: ctx.dir, tree: entries });
		cache.trees.set(key, oid);
	}
	return oid;
}

/** Whether two path -> text collections hold exactly the same files. */
export function sameFiles(a: ReadonlyMap<string, string>, b: Readonly<Record<string, string>>): boolean {
	const keys = Object.keys(b);
	if (keys.length !== a.size) return false;
	return keys.every((k) => a.get(k) === b[k]);
}
