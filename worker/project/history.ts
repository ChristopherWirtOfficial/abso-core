// History reads for the Files pages (#41; #46, disk-first 1): a folder at a version (tree), a path's life
// (pathLife), and where lines went (follow). They read through HistoryHost, the one seam the derived tables
// (abso issues 48 and 79) plug into: today the host is the project in memory.

import type { Graph, LineId, ReadView } from "../../src/engine/index.ts";
import { pathKey } from "./pathkey.ts";
import { checkReadPath, differs, type LastChange, ProjectError, utf8Bytes } from "./project.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What the history reads need from a project. */
export interface HistoryHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, { readonly name: string; readonly space: string; readonly base: number }>;
	readonly spaces: ReadonlyMap<string, Space>;
	needInit(): void;
	spaceNamed(name: string | null): Space;
	checkVersion(space: Space, version: number): void;
	viewAt(space: Space, version: number): ReadView;
	agentView(agent: { readonly name: string; readonly space: string; readonly base: number }): ReadView;
	spellingIn(view: ReadView, asked: string): string;
	pathsOf(space: Space): Map<string, PathLifeRecord>;
	lastChange(space: Space, version: number): LastChange;
	atOrBefore(list: readonly number[], version: number): number | undefined;
	removedIn(space: Space, from: number, to: number, line: LineId): { removed?: number };
}

/** A path's history in a space, as the path index keeps it. */
export interface PathLifeRecord {
	readonly changed: number[];
	readonly events: { version: number; made: boolean; other?: string }[];
}

/**
 * One folder of shared (or a named draft) at a version (#41, F1, F2, F34):
 * the folders and files directly in it, each with the last version that
 * changed it (for a folder, any file under it), who made it, when and why.
 * The root is folder "". A folder is matched by any spelling (#49).
 *
 * `agent` (#41, F25): the folder as that agent has it, unpublished changes
 * and all; `last` is as of the version it last synced to, and `changed`
 * marks an entry its unpublished work touches. `authors` (F33): each
 * entry's lines by who wrote them, as blame ?folder= gives a whole folder,
 * and its text's size in UTF-8 bytes (`bytes`, Sizes in a folder) with the
 * blobs of its binary files (`blobs`), which the Worker turns into bytes.
 */
export function tree(
	h: HistoryHost,
	folder = "",
	options: { version?: number; draft?: string | null; agent?: string; authors?: boolean } = {},
): {
	version: number;
	draft: string | null;
	agent?: string;
	folder: string;
	entries: {
		name: string;
		path: string;
		kind: "folder" | "file";
		files?: number;
		last: LastChange | null;
		changed?: true;
		authors?: { agent: string; lines: number }[];
		bytes?: number;
		blobs?: string[];
	}[];
} {
	h.needInit();
	const agent = options.agent !== undefined ? h.agents.get(options.agent) : undefined;
	if (options.agent !== undefined) {
		if (!agent) throw new ProjectError("bad-request", `there is no agent ${JSON.stringify(options.agent)}`);
		if (options.version !== undefined || (options.draft ?? null) !== null)
			throw new ProjectError("bad-request", "an agent's view is its current one: give agent alone");
	}
	const space = agent ? h.spaces.get(agent.space)! : h.spaceNamed(options.draft ?? null);
	const version = agent ? agent.base : (options.version ?? last(space));
	h.checkVersion(space, version);
	const want = folder.split("/").filter((s) => s !== "" && s !== ".");
	const wantKey = pathKey(want.join("/"));
	const base = h.viewAt(space, version);
	const view = agent ? h.agentView(agent) : base;
	const graph = h.graph;
	const index = h.pathsOf(space);
	const lastOf = (path: string): number | undefined => h.atOrBefore(index.get(path)?.changed ?? [], version);
	type Entry = {
		name: string;
		path: string;
		kind: "folder" | "file";
		files: number;
		last: number | undefined;
		changed: boolean;
		authors?: Map<string, number>;
		bytes: number;
		blobs?: string[];
	};
	const entries = new Map<string, Entry>();
	let stored: string | undefined;
	const entryOf = (path: string): Entry | undefined => {
		const parts = path.split("/");
		if (parts.length <= want.length || (want.length > 0 && pathKey(parts.slice(0, want.length).join("/")) !== wantKey))
			return undefined;
		stored ??= parts.slice(0, want.length).join("/");
		const name = parts[want.length]!;
		const kind = parts.length === want.length + 1 ? "file" : "folder";
		const key = `${kind} ${kind === "folder" ? pathKey(name) : name}`;
		let e = entries.get(key);
		if (!e)
			entries.set(
				key,
				(e = {
					name,
					path: parts.slice(0, want.length + 1).join("/"),
					kind,
					files: 0,
					last: undefined,
					changed: false,
					bytes: 0,
				}),
			);
		return e;
	};
	for (const path of view.paths()) {
		const e = entryOf(path);
		if (!e) continue;
		e.files++;
		const v = lastOf(path);
		if (v !== undefined && (e.last === undefined || v > e.last)) e.last = v;
		if (agent && differs(base, view, path)) e.changed = true;
		if (options.authors) {
			const counts = (e.authors ??= new Map());
			for (const l of view.lines(path)) {
				const author = graph.atom(l.atom).author;
				counts.set(author, (counts.get(author) ?? 0) + 1);
			}
			const blob = view.attrs(path).blob;
			if (blob !== null) (e.blobs ??= []).push(blob);
			else e.bytes += utf8Bytes(view.text(path));
		}
	}
	// A file the agent took out still marks the folder it was in, when that folder is still listed.
	if (agent)
		for (const path of base.paths())
			if (!view.hasFile(path)) {
				const parts = path.split("/");
				if (parts.length <= want.length + 1) continue;
				const key = `folder ${pathKey(parts[want.length]!)}`;
				const e = entries.get(key);
				if (e && (want.length === 0 || pathKey(parts.slice(0, want.length).join("/")) === wantKey)) e.changed = true;
			}
	if (want.length > 0 && stored === undefined) {
		throw new ProjectError(
			"not-found",
			`there is no folder ${want.join("/")} in ${space.name === SHARED ? "shared" : `draft ${space.name}`} at version ${version}`,
		);
	}
	const list = [...entries.values()].sort((a, b) =>
		a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	return {
		version,
		draft: space.name === SHARED ? null : space.name,
		...(agent ? { agent: agent.name } : {}),
		folder: stored ?? "",
		entries: list.map((e) => ({
			name: e.name,
			path: e.path,
			kind: e.kind,
			...(e.kind === "folder" ? { files: e.files } : {}),
			last: e.last === undefined ? null : h.lastChange(space, e.last),
			...(e.changed ? { changed: true as const } : {}),
			...(e.authors
				? {
						authors: [...e.authors]
							.map(([agent, lines]) => ({ agent, lines }))
							.sort((a, b) => b.lines - a.lines || (a.agent < b.agent ? -1 : 1)),
					}
				: {}),
			...(options.authors ? { bytes: e.bytes } : {}),
			...(e.blobs ? { blobs: e.blobs } : {}),
		})),
	};
}

/**
 * A path's life at a version (#41, F10, F30): whether it exists, how many
 * versions changed it, its last change, and the version that made it (and
 * the name it was moved from). When it doesn't exist: the version that
 * took it out (and where it was moved to), and the next version that makes
 * it again, if any.
 */
export function pathLife(
	h: HistoryHost,
	path: string,
	options: { version?: number; draft?: string | null } = {},
): {
	path: string;
	version: number;
	exists: boolean;
	versions: number;
	last: LastChange | null;
	made?: LastChange & { from?: string };
	removed?: LastChange & { to?: string };
	next?: LastChange & { from?: string };
} {
	h.needInit();
	checkReadPath(path);
	const space = h.spaceNamed(options.draft ?? null);
	const version = options.version ?? last(space);
	h.checkVersion(space, version);
	const index = h.pathsOf(space);
	let stored = path;
	if (!index.has(path)) {
		const twins = [...index.keys()].filter((p) => pathKey(p) === pathKey(path));
		if (twins.length === 1) stored = twins[0]!;
	}
	const life = index.get(stored);
	const exists = h.viewAt(space, version).hasFile(stored);
	const count = life ? life.changed.filter((v) => v <= version).length : 0;
	const lastV = life ? h.atOrBefore(life.changed, version) : undefined;
	const event = (e: { version: number; other?: string }, key: "from" | "to") => ({
		...h.lastChange(space, e.version),
		...(e.other !== undefined ? { [key]: e.other } : {}),
	});
	const before = (life?.events ?? []).filter((e) => e.version <= version);
	const made = exists ? before.filter((e) => e.made).pop() : undefined;
	const removed = !exists ? before.filter((e) => !e.made).pop() : undefined;
	const next = !exists ? (life?.events ?? []).find((e) => e.made && e.version > version) : undefined;
	return {
		path: stored,
		version,
		exists,
		versions: count,
		last: lastV === undefined ? null : h.lastChange(space, lastV),
		...(made ? { made: event(made, "from") } : {}),
		...(removed ? { removed: event(removed, "to") } : {}),
		...(next ? { next: event(next, "from") } : {}),
	};
}

/**
 * Lines followed from one version to another (#41, F15): lines from..to of
 * `path` at `version`, found by their ids at version `at` (the newest by
 * default), in whatever file they are in now. A line that's gone says which
 * version took it out.
 */
export function follow(
	h: HistoryHost,
	path: string,
	version: number,
	from: number,
	to: number,
	options: { at?: number; draft?: string | null } = {},
): {
	path: string;
	version: number;
	from: number;
	to: number;
	at: number;
	lines: { was: number; file?: string; now: number | null; removed?: number }[];
	ranges: { file: string; from: number; to: number }[];
	removed: { from: number; to: number; version: number }[];
} {
	h.needInit();
	checkReadPath(path);
	const space = h.spaceNamed(options.draft ?? null);
	h.checkVersion(space, version);
	const at = options.at ?? last(space);
	h.checkVersion(space, at);
	if (at < version)
		throw new ProjectError("bad-request", `follow goes forward: at (${at}) is before version ${version}`);
	const then = h.viewAt(space, version);
	const file = h.spellingIn(then, path);
	if (!then.hasFile(file))
		throw new ProjectError(
			"not-found",
			`${path} isn't in ${space.name === SHARED ? "shared" : `draft ${space.name}`} at version ${version}`,
		);
	const lines = then.lines(file);
	if (lines.length === 0)
		throw new ProjectError("bad-request", `${file} has no lines to follow (a binary file, or one kept whole)`);
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > lines.length) {
		throw new ProjectError(
			"bad-request",
			`${file} has ${lines.length} lines at version ${version}; ask for from..to within 1-${lines.length}`,
		);
	}
	const now = h.viewAt(space, at);
	const out: { was: number; file?: string; now: number | null; removed?: number }[] = [];
	for (let n = from; n <= to; n++) {
		const id = lines[n - 1]!.id;
		const where = now.fileOf(id);
		const i = now.lineNumber(where, id);
		if (i >= 0) out.push({ was: n, file: where, now: i + 1 });
		else out.push({ was: n, now: null, ...h.removedIn(space, version, at, id) });
	}
	const ranges: { file: string; from: number; to: number }[] = [];
	const removed: { from: number; to: number; version: number }[] = [];
	for (const l of out) {
		if (l.now !== null) {
			const r = ranges[ranges.length - 1];
			if (r && r.file === l.file && r.to + 1 === l.now) r.to = l.now;
			else ranges.push({ file: l.file!, from: l.now, to: l.now });
		} else if (l.removed !== undefined) {
			const r = removed[removed.length - 1];
			if (r && r.version === l.removed && r.to + 1 === l.was) r.to = l.was;
			else removed.push({ from: l.was, to: l.was, version: l.removed });
		}
	}
	return { path: file, version, from, to, at, lines: out, ranges, removed };
}
