import { View } from "../../src/engine/index.ts";
// The version list reads: log (versions newest first, or one file's history), ribbon (who published each version),
// show (one version's changes), fileAt, compare and viewAt. They read through LogHost; today the host is the project
// in memory.

import type { AtomId, Graph, ReadView } from "../../src/engine/index.ts";
import { checkReadPath } from "./path-rules.ts";
import type { PathIndex } from "./pathindex.ts";
import { ProjectError } from "./project-error.ts";
import type { FileChange, LogAnswer, LogEntry, ShowAnswer } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";
import { changesBetween } from "./view-changes.ts";

/** What the version list reads need from a project. */
export interface LogHost {
	readonly graph: Graph;
	readonly paths: Pick<PathIndex, "knowsFiles" | "versionFiles" | "versionShape">;
	readonly labels: ReadonlyMap<string, readonly number[]>;
	shared(): Space;
	needInit(): void;
	spaceFor(options: { draft?: string | null; agent?: string }): Space;
	checkVersion(space: Space, version: number): void;
	viewAt(space: Space, version: number): ReadView;
	view(set: ReadonlySet<AtomId>): ReadView;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	spellingIn(view: ReadView, path: string): string;
	versionChange(space: Space, version: number): number | undefined;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
}

/**
 * The versions of shared (or of a named draft), newest first: who
 * published each, why, and which files it touched. `limit` defaults to 50.
 */
export function log(
	host: LogHost,
	options: {
		draft?: string | null;
		agent?: string;
		limit?: number;
		path?: string;
		before?: number;
		follow?: boolean;
	} = {},
): LogAnswer {
	host.needInit();
	const space = host.spaceFor(options);
	const limit = Number.isInteger(options.limit) && options.limit! > 0 ? Math.min(options.limit!, 200) : 50;
	if (options.path !== undefined) checkReadPath(options.path);
	if (options.before !== undefined && (!Number.isInteger(options.before) || options.before < 0))
		throw new ProjectError("bad-request", "before must be a version number");
	const versions: LogEntry[] = [];
	// Paging (#41, the website): `before` starts the page below that version; `next` is the `before` for the page after.
	let v = Math.min(last(space), (options.before ?? last(space) + 1) - 1);
	// Any spelling reads the stored one (#41, F7). With follow, the history follows moves (F27): before
	// the version that moved the file in, it's the file it came from.
	const path = options.path === undefined ? undefined : host.spellingIn(host.viewAt(space, last(space)), options.path);
	const names = path === undefined ? [] : options.follow ? namesBefore(host, space, path) : [{ path, since: 0 }];
	const nameAt = (version: number): string => names.find((n) => version >= n.since)?.path ?? path!;
	// A file's history (#43): only versions whose changes name the file, or a file moves can carry lines from, can have changed it.
	const sources = path === undefined ? undefined : new Set(names.flatMap((n) => [...moveSources(host.graph, n.path)]));
	const g = host.graph;
	const views = new Map<number, ReadView>();
	for (; v >= 0 && versions.length < limit; v--) {
		if (sources && !host.paths.knowsFiles(space, v)) {
			const p = space.versions[v]!;
			if (![...p.atoms, ...(p.dropped ?? [])].some((id) => g.filesOf(id).some((f) => sources.has(f)))) continue;
		}
		const entry = logEntry(host, space, v, views);
		// The walk goes down: a view above this version won't be needed again (#46).
		views.delete(v + 1);
		// With a path: only the versions that changed that file (its history), under its name then.
		if (path === undefined) versions.push(entry);
		else if (entry.files.includes(nameAt(v))) versions.push(nameAt(v) === path ? entry : { ...entry, path: nameAt(v) });
	}
	const next = v >= 0 && versions.length > 0 ? versions[versions.length - 1]!.version : undefined;
	const movedFrom = names.slice(0, -1).map((n, i) => ({ path: names[i + 1]!.path, version: n.since }));
	return {
		draft: space.name === SHARED ? null : space.name,
		version: last(space),
		versions,
		...(next !== undefined ? { next } : {}),
		...(path !== undefined ? { path } : {}),
		...(movedFrom.length > 0 ? { movedFrom } : {}),
	};
}

/**
 * A file's names back through moves (#41, F27), newest first: each with the
 * version from which it had that name. Found from the atoms that moved lines
 * into it (abso mv), so it never guesses from how alike two files are.
 */
function namesBefore(host: LogHost, space: Space, path: string): { path: string; since: number }[] {
	const g = host.graph;
	const out: { path: string; since: number }[] = [];
	let cur = path;
	let below = last(space) + 1;
	const movers = g.movers();
	for (;;) {
		// The newest version below `below` that moved another file into `cur`.
		const into = movers
			.filter((id) => g.filesOf(id).includes(cur))
			.map((id) => space.publishedIn.get(id))
			.filter((v): v is number => v !== undefined && v < below)
			.toSorted((a, b) => b - a);
		let found: { from: string; version: number } | undefined;
		for (const version of into) {
			const move = host.paths.versionShape(space, version).moves.find(([, to]) => to === cur);
			if (move) {
				found = { from: move[0], version };
				break;
			}
		}
		out.push({ path: cur, since: found?.version ?? 0 });
		if (!found) break;
		cur = found.from;
		below = found.version;
	}
	return out;
}

/**
 * The files whose lines can be in `path` (#43): itself, and any file a move
 * shares with one already found. A line is in a file other than the one it
 * was written in only when a move carried it, or a line before it, there;
 * that move names both files.
 */
function moveSources(g: Graph, path: string): Set<string> {
	const out = new Set([path]);
	const movers = g.movers().map((id) => g.filesOf(id));
	for (let grew = true; grew; ) {
		grew = false;
		for (const files of movers) {
			if (!files.some((f) => out.has(f))) continue;
			for (const f of files) if (!out.has(f)) out.add(f), (grew = true);
		}
	}
	return out;
}

/**
 * Shared's versions in one small answer, for the website's version ribbon
 * (#43): `authors[v]` indexes `agents`, which are in order of each agent's
 * first version. No files, so it costs nothing on a long history.
 */
export function ribbon(host: LogHost): { version: number; agents: string[]; authors: number[] } {
	host.needInit();
	const shared = host.shared();
	const agents: string[] = [];
	const index = new Map<string, number>();
	const authors = shared.versions.map((p) => {
		let i = index.get(p.agent);
		if (i === undefined) index.set(p.agent, (i = agents.push(p.agent) - 1));
		return i;
	});
	return { version: last(shared), agents, authors };
}

/** One version of shared (or of a named draft): who, why, and each file it changed, before and after. */
export function show(
	host: LogHost,
	version: number,
	options: { draft?: string | null; agent?: string } = {},
): ShowAnswer {
	host.needInit();
	const space = host.spaceFor(options);
	if (!Number.isInteger(version) || version < 0 || version > last(space)) {
		throw new ProjectError(
			"bad-request",
			`there is no version ${String(version)}${space.name === SHARED ? "" : ` of draft ${space.name}`}`,
		);
	}
	const entry = logEntry(host, space, version);
	const before = version === 0 ? new View(host.graph, []) : host.viewAt(space, version - 1);
	const after = host.viewAt(space, version);
	return {
		...entry,
		draft: space.name === SHARED ? null : space.name,
		diff: changesBetween(before, after, entry.files),
	};
}

function logEntry(host: LogHost, space: Space, version: number, views?: Map<number, ReadView>): LogEntry {
	const p = space.versions[version]!;
	let changes = 0;
	for (const id of p.atoms) {
		const atom = host.graph.atom(id);
		const ownLines = atom.inserts.length > 0 || host.graph.deleteCount(id) > 0;
		if (ownLines) changes++;
	}
	const files = host.paths.versionFiles(space, version, views);
	const change = host.versionChange(space, version);
	const droppedIn = p.atoms.length > 0 ? space.droppedIn.get(p.atoms[p.atoms.length - 1]!) : undefined;
	return {
		version,
		agent: p.agent,
		message: p.message,
		time: p.time,
		changes,
		...(change !== undefined ? { change } : {}),
		files: [...files],
		...(p.droppedVersions ? { drops: [...p.droppedVersions] } : {}),
		...(droppedIn !== undefined ? { droppedIn } : {}),
		...labelsOn(host, space, version),
		...(p.originalMessage !== undefined ? { originalMessage: p.originalMessage } : {}),
	};
}

function labelsOn(host: LogHost, space: Space, version: number): { labels?: string[] } {
	if (space.name !== SHARED) return {};
	const names = [...host.labels]
		.filter(([, vs]) => vs.includes(version))
		.map(([n]) => n)
		.toSorted();
	return names.length > 0 ? { labels: names } : {};
}

/** A file as it was at a version of shared (or a named draft): its text, or null when it didn't exist. */
export function fileAt(
	host: LogHost,
	path: string,
	version: number,
	options: { draft?: string | null; agent?: string } = {},
): { path: string; version: number; text: string | null; blob?: string } {
	host.needInit();
	checkReadPath(path);
	const space = host.spaceFor(options);
	host.checkVersion(space, version);
	const view = host.viewAt(space, version);
	// Any spelling reads the stored one (#41, F7).
	const file = host.spellingIn(view, path);
	const blob = view.attrs(file).blob;
	return {
		path: file,
		version,
		text: view.hasFile(file) ? view.text(file) : null,
		...(blob !== null ? { blob } : {}),
	};
}

/** Every file that differs between two versions of shared (or a named draft), before (at `from`) and after (at `to`). */
export function compare(
	host: LogHost,
	from: number,
	to: number,
	options: { draft?: string | null; agent?: string } = {},
): { from: number; to: number; files: FileChange[] } {
	host.needInit();
	const space = host.spaceFor(options);
	host.checkVersion(space, from);
	host.checkVersion(space, to);
	const before = host.viewAt(space, from);
	const after = host.viewAt(space, to);
	const files = new Set<string>();
	// A stored writer keeps each shared version's changed files (version-files.ts, abso Capacity): every file that
	// differs between two versions changed in one between them, so those lists are the candidates, not every atom
	// either set holds.
	if (space.name === SHARED && host.graph.packedFiles) {
		for (let v = Math.min(from, to) + 1; v <= Math.max(from, to); v++)
			for (const file of host.paths.versionFiles(space, v)) files.add(file);
		return { from, to, files: changesBetween(before, after, files) };
	}
	const a = host.at(space, from);
	const b = host.at(space, to);
	for (const [x, y] of [
		[a, b],
		[b, a],
	] as const) {
		for (const file of host.touchedFiles(
			(function* () {
				for (const id of x) if (!y.has(id)) yield id;
			})(),
			[before, after],
		))
			files.add(file);
	}
	return { from, to, files: changesBetween(before, after, files) };
}

/** A version of shared (or of a named draft) as a ReadView, for reading lines (blame at a version). */
export function viewAt(
	host: LogHost,
	version: number,
	options: { draft?: string | null; agent?: string } = {},
): ReadView {
	host.needInit();
	const space = host.spaceFor(options);
	host.checkVersion(space, version);
	return host.viewAt(space, version);
}
