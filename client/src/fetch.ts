// abso fetch <glob...> and abso run --fetch <glob>: bring files the box made
// back into the folder (#37, Builder 4). Only paths abso ignores are written,
// so a fetched file never becomes an edit; the rest are named and left alone.
// Every path is screened as a sync's are (safety.ts): the box runs whatever
// the folder held, so its files are not trusted any more than the server's.

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Api } from "./api.ts";
import { UsageError } from "./args.ts";
import { isLocalOnly } from "./core.ts";
import { absolute, loadIgnore, writeFileAtomic } from "./folder.ts";
import { type Refused, throughLink, unsafePath } from "./safety.ts";
import { untarGz } from "./tar.ts";

export interface Fetched {
	readonly written: string[];
	/** Matched in the box but not written, and why. */
	readonly skipped: Refused[];
	/** Globs that matched nothing (or the box had stopped). */
	readonly empty: string[];
}

/** Whether abso leaves `rel` out: itself, or a folder on its way (git's rule: nothing under an ignored folder counts). */
export function ignoredHere(ignore: ReturnType<typeof loadIgnore>, rel: string, isDir = false): boolean {
	const parts = rel.split("/");
	for (let i = 1; i < parts.length; i++) if (ignore(parts.slice(0, i).join("/"), true)) return true;
	return ignore(rel, isDir);
}

export async function fetchFromBox(root: string, api: Api, globs: readonly string[]): Promise<Fetched> {
	if (globs.length === 0) throw new UsageError('name what to fetch: abso fetch <glob...>, like abso fetch "out/*.png"');
	const ignore = loadIgnore(root);
	const written: string[] = [];
	const skipped: Refused[] = [];
	const empty: string[] = [];
	const seen = new Set<string>();
	for (const glob of globs) {
		const gz = await api.boxFiles(glob);
		if (gz === null) {
			empty.push(glob);
			continue;
		}
		for (const e of untarGz(gz)) {
			if (seen.has(e.path)) continue;
			seen.add(e.path);
			const why =
				unsafePath(e.path) ??
				(isLocalOnly(e.path) ? "it is under .git, .claude, .abso or node_modules, which stay local" : undefined) ??
				(throughLink(root, e.path) ? "a folder on its way is a link" : undefined) ??
				(e.link !== undefined ? "it is a link; fetch makes none" : undefined) ??
				(!ignoredHere(ignore, e.path)
					? "abso records it, so writing it would make an edit; add it to .absoignore to fetch it"
					: undefined);
			if (why !== undefined) {
				skipped.push({ path: e.path, why });
				continue;
			}
			const path = absolute(root, e.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileAtomic(path, e.data);
			if (e.mode !== undefined && (e.mode & 0o111) !== 0) {
				try {
					chmodSync(path, 0o755);
				} catch {
					// The bit is a convenience here.
				}
			}
			written.push(e.path);
		}
	}
	return { written: written.sort(), skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)), empty };
}

/** What a fetch says: what it wrote, what it left alone and why, and globs that found nothing. */
export function fetchedText(f: Fetched): string[] {
	const shown = (list: readonly string[]) =>
		list.length <= 8 ? list.join(", ") : `${list.slice(0, 8).join(", ")}, and ${list.length - 8} more`;
	return [
		...(f.written.length > 0
			? [
					`Fetched ${f.written.length === 1 ? "1 file" : `${f.written.length} files`} from the box: ${shown(f.written)}.`,
				]
			: []),
		...(f.skipped.length > 0
			? [`Not fetched (${f.skipped.length}):`, ...f.skipped.map((s) => `  ${s.path}: ${s.why}`)]
			: []),
		...f.empty.map(
			(g) => `Nothing in the box matches ${g} (or the box has stopped: it keeps /w only until it idles out).`,
		),
	];
}
