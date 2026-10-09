// abso export <dir> [--version N]: one published version of this folder's
// space, written to a folder of its own, for a build that doesn't move while
// shared does (#37). The folder gets .abso-export naming the
// version, to stamp the build with: JSON on one line, in a file with no
// extension, so the exported project's own formatter and linter pass it by.
// Exporting again replaces the folder, keeping node_modules (and what --keep
// names) so a build needs no new install.
//
// The version is rebuilt as `abso run --at` rebuilds it (at.ts), from the
// known copies and one compare; the server's listing of that version (#37)
// then checks that no file is left out.

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Where } from "./api.ts";
import { type Parsed, str, UsageError } from "./args.ts";
import { globTest, snapshotAt, snapshotEntries } from "./at.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { ignoredHere } from "./fetch.ts";
import { loadIgnore, relativeTo } from "./folder.ts";
import { type Refused, unsafePath } from "./safety.ts";

/** The file an export leaves in its folder: what it holds, and the sign that the folder is one export may replace. */
export const EXPORT_STAMP = ".abso-export";
/** Its earlier names: an export made then still counts as one. A .json name drew the project's formatter. */
const OLD_EXPORT_STAMPS = [".abso-export.json", ".avcs-export.json"];

/** Where an export may go: outside the abso folder, or in a part of it abso leaves out. Empty, or an earlier export. */
function checkTarget(root: string, target: string): void {
	const inside = relativeTo(root, target);
	if (inside === undefined && (target === root || relativeTo(target, root) !== undefined)) {
		throw new UsageError(`${target} holds this abso folder; export to a folder of its own`);
	}
	if (inside !== undefined && !ignoredHere(loadIgnore(root), inside, true)) {
		throw new UsageError(
			`${inside} is inside this abso folder, so abso would record the export as your edits. Export outside the folder, or into a folder .absoignore leaves out`,
		);
	}
	if (!existsSync(target)) return;
	if (!statSync(target).isDirectory()) throw new UsageError(`${target} is a file; export to a folder`);
	if (
		readdirSync(target).length > 0 &&
		![EXPORT_STAMP, ...OLD_EXPORT_STAMPS].some((n) => existsSync(join(target, n)))
	) {
		throw new UsageError(
			`${target} has files in it; export to an empty folder (an export replaces only a folder an earlier export made)`,
		);
	}
}

/**
 * Empties an earlier export for the next, except what `keep` names: node_modules
 * always (abso never exports it, and an install takes a while), and --keep's
 * globs. Returns the kept paths, the top-most of each.
 */
function clearExport(dir: string, keep: (rel: string) => boolean, rel = ""): string[] {
	const kept: string[] = [];
	for (const e of readdirSync(join(dir, ...rel.split("/").filter(Boolean)), { withFileTypes: true })) {
		const path = rel === "" ? e.name : `${rel}/${e.name}`;
		const full = join(dir, ...path.split("/"));
		if (e.name === "node_modules" || keep(path)) {
			kept.push(path);
			continue;
		}
		if (e.isDirectory() && !e.isSymbolicLink()) {
			const inner = clearExport(dir, keep, path);
			kept.push(...inner);
			if (inner.length > 0) continue;
		}
		rmSync(full, { recursive: true, force: true });
	}
	return kept;
}

export async function runExport(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError("export takes the folder to write: abso export <dir> [--version <N>]");
	const { root, config, api } = open(env);
	const target = resolve(env.cwd, args.positionals[0]!);
	checkTarget(root, target);
	const rawVersion = str(args, "version");
	if (rawVersion !== undefined && !/^\d+$/.test(rawVersion))
		throw new UsageError(`--version is a version number (got ${JSON.stringify(rawVersion)})`);
	const diff = await api.diff();
	const where: Where = { draft: diff.draft };
	// The listing names the version (the newest by default) and every file it holds; a server from before it answers 404.
	const listing = await api
		.filesAt(diff.draft, rawVersion === undefined ? undefined : Number(rawVersion))
		.catch(() => undefined);
	const version =
		rawVersion !== undefined ? Number(rawVersion) : (listing?.version ?? (await api.log(where, 1)).version);
	const snap = await snapshotAt(root, api, version);
	const skipped: Refused[] = [];
	if (listing !== undefined) {
		const holds = new Set(listing.files);
		for (const rel of [...snap.files.keys()]) if (!holds.has(rel)) snap.files.delete(rel);
		// Files the known copies lack (a folder that missed some, #37): asked for one by one.
		for (const rel of listing.files) {
			if (snap.files.has(rel)) continue;
			const file = await api.fileAt(rel, version, where);
			if (file.text !== null) snap.files.set(rel, { text: file.text });
			else
				skipped.push({
					path: rel,
					why: "a binary file this folder has no copy of; abso sync --full, then export again",
				});
		}
	}
	const entries = await snapshotEntries(api, snap);
	// Built before anything is removed, so a failed export leaves an earlier one whole.
	const keepGlob = str(args, "keep");
	const kept = existsSync(target) ? clearExport(target, keepGlob === undefined ? () => false : globTest(keepGlob)) : [];
	mkdirSync(target, { recursive: true });
	let written = 0;
	for (const e of entries) {
		const why = unsafePath(e.path) ?? (e.link !== undefined ? "it is a link; export makes none" : undefined);
		if (why !== undefined) {
			skipped.push({ path: e.path, why });
			continue;
		}
		const path = join(target, ...e.path.split("/"));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, e.data);
		if (e.mode !== undefined) {
			try {
				chmodSync(path, e.mode);
			} catch {
				// The bit is a convenience here.
			}
		}
		written++;
	}
	const space = diff.draft === null ? "shared" : `draft ${diff.draft}`;
	const stamp = {
		project: config.project,
		space: diff.draft ?? "shared",
		version,
		files: written,
		exportedAt: new Date().toISOString(),
	};
	writeFileSync(join(target, EXPORT_STAMP), `${JSON.stringify(stamp)}\n`);
	return {
		text: [
			`Exported version ${version} of ${space} to ${target}: ${plural(written, "file")}. ${EXPORT_STAMP} there names the version; abso export to the same folder replaces it.`,
			...(kept.length > 0 ? [`Kept from the earlier export: ${kept.join(", ")}.`] : []),
			...(skipped.length > 0
				? [`Not exported (${skipped.length}):`, ...skipped.map((s) => `  ${s.path}: ${s.why}`)]
				: []),
		].join("\n"),
		json: { ...stamp, dir: target, kept, skipped },
	};
}
