// Spellings (#49), moved out of project.ts (abso issue 46): whether paths
// would make two spellings of one name live at once, and which spelling a
// path has in a view. Plain functions of views; the project calls them.

import type { View } from "../../src/engine/index.ts";
import { pathKey } from "./pathkey.ts";

/**
 * Whether paths entering shared would make two spellings of one name live
 * at once (#49; Git Lessons' review, batch 3): two
 * files whose names differ only in case or Unicode form, or a file and a
 * folder with one name. No disk holds both, and the git copy can't either.
 * `touched` are the paths the work changes; `now` is shared as it is, so a
 * clash shared already holds isn't charged to this work. The answer is the
 * refusal's reason, or undefined.
 */
export function clashIn(view: View, touched: Iterable<string>, now: View): string | undefined {
	const byKey = new Map<string, string[]>();
	for (const p of view.knownPaths()) {
		const k = pathKey(p);
		const list = byKey.get(k);
		if (list) list.push(p);
		else byKey.set(k, [p]);
	}
	const liveAs = (key: string, but?: string) => byKey.get(key)?.find((q) => q !== but && view.hasFile(q));
	const old = (a: string, b: string) => now.hasFile(a) && now.hasFile(b);
	for (const p of [...touched].sort()) {
		if (!view.hasFile(p)) continue;
		const key = pathKey(p);
		const twin = liveAs(key, p);
		if (twin !== undefined && !old(p, twin))
			return `${p} and ${twin} would both be in shared, but they're one file, spelled two ways (case or Unicode form). Keep one: abso mv ${p} ${twin}, or put your change into ${twin}, then publish again.`;
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) {
			const file = liveAs(pathKey(parts.slice(0, i).join("/")));
			if (file !== undefined && !old(p, file))
				return `${p} puts a file in folder ${parts.slice(0, i).join("/")}, but ${file} is a file of that name in shared, and no disk holds both. Move one of them (abso mv), then publish again.`;
		}
		for (const [k, qs] of byKey) {
			if (!k.startsWith(`${key}/`)) continue;
			const under = qs.find((q) => view.hasFile(q));
			if (under !== undefined && !old(p, under))
				return `${p} is a file, but ${under} makes a folder of that name in shared, and no disk holds both. Move one of them (abso mv), then publish again.`;
		}
	}
	return undefined;
}

/** The same check for a list of paths alone (init, a git commit): the first clash among them. */
export function clashInPaths(paths: readonly string[]): string | undefined {
	const files = new Map<string, string>();
	for (const p of paths) {
		const twin = files.get(pathKey(p));
		if (twin !== undefined && twin !== p)
			return `${twin} and ${p} are one file, spelled two ways (case or Unicode form); keep one`;
		files.set(pathKey(p), p);
	}
	for (const p of paths) {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) {
			const file = files.get(pathKey(parts.slice(0, i).join("/")));
			if (file !== undefined)
				return `${file} is a file, and ${p} puts a file in a folder of that name; no disk holds both`;
		}
	}
	return undefined;
}

/** The spelling a path has in this view: itself, or the one existing file it matches by pathKey (case and Unicode form ignored). */
export function spellingOf(view: View, path: string): string {
	if (view.hasFile(path)) return path;
	const key = pathKey(path);
	// Known paths first, by key, then only those laid out (#46).
	const twins = view.knownPaths().filter((p) => pathKey(p) === key && view.hasFile(p));
	return twins.length === 1 ? twins[0]! : path;
}
