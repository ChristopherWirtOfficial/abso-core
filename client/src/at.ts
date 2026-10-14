// abso run --at <version> [--files <glob>]: run a past version of the
// folder's space, or old copies of a few files, in the box, without touching
// a file in the folder (Backtracker's bisect, #25). Swapping files in by hand
// let the edit hook record the old copies.
//
// The version is rebuilt from what the client already knows, in two calls:
// the known copies are this agent's view (its base plus its recorded draft);
// its diff gives each drafted file as it was at the base; and compare(N, base)
// gives each file that differs between version N and the base, as it was at N.

import type { Api, FileChange, Where } from "./api.ts";
import { UsageError } from "./args.ts";
import { readKnownBlobs } from "./blobs.ts";
import { isLocalOnly } from "./core.ts";
import { listKnown, readKnown } from "./folder.ts";
import { type FullMode, PLAIN, readKnownModes } from "./modes.ts";
import type { TarEntry } from "./tar.ts";

/** One file of a version: its text, or its bytes by hash; and its mode. */
type Held = { readonly text: string } | { readonly blob: string };

export interface Snapshot {
	readonly version: number;
	readonly files: Map<string, Held>;
	readonly modes: Map<string, FullMode>;
}

/** Each file as it is on one side of a change (`before` unless said), applied to the snapshot. */
export function applySide(s: Snapshot, changes: readonly FileChange[], side: "before" | "after" = "before"): void {
	for (const f of changes) {
		if (isLocalOnly(f.path)) continue;
		const blob = f.blob?.[side] ?? null;
		const text = f[side];
		if (blob !== null) s.files.set(f.path, { blob });
		else if (text !== null) s.files.set(f.path, { text });
		else {
			s.files.delete(f.path);
			s.modes.delete(f.path);
			continue;
		}
		if (f.mode) s.modes.set(f.path, { exec: f.mode[side].exec === true, link: f.mode[side].link ?? null });
	}
}

/** The folder's space as it was at `version`: every file, and its mode. */
export async function snapshotAt(root: string, api: Api, version: number): Promise<Snapshot> {
	const diff = await api.diff();
	if (diff.base === null) throw new UsageError("this folder has no version yet: run abso pull first");
	const where: Where = { draft: diff.draft };
	// This agent's view, from its known copies.
	const s: Snapshot = { version, files: new Map(), modes: new Map() };
	for (const rel of listKnown(root)) {
		if (isLocalOnly(rel)) continue;
		const text = readKnown(root, rel);
		if (text !== undefined) s.files.set(rel, { text });
	}
	for (const [rel, sha] of readKnownBlobs(root)) s.files.set(rel, { blob: sha });
	for (const [rel, mode] of readKnownModes(root)) if (s.files.has(rel)) s.modes.set(rel, mode);
	// Its base: the draft's changes taken back out.
	applySide(s, diff.files);
	// Version N: what differs from the base, as it was at N.
	if (version !== diff.base) applySide(s, (await api.compare(version, diff.base, where)).files);
	return s;
}

/** A glob (or several, comma-separated) as a test on folder-relative paths. `**` crosses folders, `*` and `?` don't; a plain path matches itself and what is under it. */
export function globTest(globs: string): (rel: string) => boolean {
	const tests = globs
		.split(",")
		.map((g) => g.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
		.filter((g) => g !== "")
		.map((g) => {
			if (!/[*?[]/.test(g)) return (rel: string) => rel === g || rel.startsWith(`${g}/`);
			let re = "";
			for (let i = 0; i < g.length; i++) {
				const c = g[i]!;
				if (c === "*" && g[i + 1] === "*") {
					re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
					i += g[i + 2] === "/" ? 2 : 1;
				} else if (c === "*") re += "[^/]*";
				else if (c === "?") re += "[^/]";
				else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			}
			const r = new RegExp(`^${re}$`);
			return (rel: string) => r.test(rel);
		});
	if (tests.length === 0) throw new UsageError('--files needs a path or a glob, like --files "src/*.ts"');
	return (rel) => tests.some((t) => t(rel));
}

/** The tar entries for a snapshot's files (all of them, or those `pick` takes), fetching blob bytes. */
export async function snapshotEntries(
	api: Api,
	s: Snapshot,
	pick: (rel: string) => boolean = () => true,
): Promise<TarEntry[]> {
	const out: TarEntry[] = [];
	for (const [rel, held] of [...s.files].sort(([a], [b]) => a.localeCompare(b))) {
		if (!pick(rel)) continue;
		const mode = s.modes.get(rel) ?? PLAIN;
		if (mode.link !== null) {
			out.push({ path: rel, data: new Uint8Array(0), link: mode.link });
			continue;
		}
		const data = "blob" in held ? await api.getBlob(held.blob) : new TextEncoder().encode(held.text);
		const script = data[0] === 0x23 && data[1] === 0x21;
		out.push({ path: rel, data, ...(mode.exec || script ? { mode: 0o755 } : {}) });
	}
	return out;
}
