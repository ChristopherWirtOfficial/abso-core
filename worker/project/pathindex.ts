import { View } from "../../src/engine/index.ts";
// Each version's files and shape, and each path's history in a space (#41; #46, disk-first 1). Built the first
// time it's asked for and kept up as versions land; a version's files are also kept in the shapes table, so a
// load needn't lay them out again.

import type { AtomId, Graph, LineId, ReadView } from "../../src/engine/index.ts";
import {
	differs,
	type LastChange,
	type PathLife,
	type ProjectOptions,
	shapeStamp,
	type VersionShape,
} from "./project.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What the path index needs from a project. */
export interface PathIndexDeps {
	readonly graph: Graph;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	viewAt(space: Space, version: number): ReadView;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
	readonly shapes: ProjectOptions["shapes"];
}

export class PathIndex {
	readonly #deps: PathIndexDeps;

	constructor(deps: PathIndexDeps) {
		this.#deps = deps;
	}

	/** Whether a version's files are already worked out (a file's log skips versions that can't name it, #43). */
	knowsFiles(space: Space, version: number): boolean {
		return this.#filesCache.get(space)?.has(version) ?? false;
	}

	/** Each version's changed files (#43): a published version never changes, so they're worked out once. */
	readonly #filesCache = new WeakMap<Space, Map<number, string[]>>();

	/** Each version's files made and taken out, and moves (#41), worked out with its files. */
	readonly #shapeCache = new WeakMap<Space, Map<number, VersionShape>>();

	/** The files at the newest version folded so far from kept shapes, per space (keptPaths). */
	readonly #keptPaths = new WeakMap<Space, { version: number; files: Set<string> }>();

	/**
	 * The files a space has at a version, from the kept rows of every version up to it: each one's files made and
	 * taken out, folded from version 0 (abso Capacity). Undefined when a version has no kept row that describes it;
	 * then the caller lays the version out.
	 */
	keptPaths(space: Space, version: number): string[] | undefined {
		let fold = this.#keptPaths.get(space);
		if (!fold || fold.version > version) fold = { version: -1, files: new Set() };
		const files = new Set(fold.files);
		for (let v = fold.version + 1; v <= version; v++) {
			if (!this.#keptFiles(space, v)) return undefined;
			const shape = this.#shapeCache.get(space)!.get(v)!;
			for (const f of shape.gone) files.delete(f);
			for (const f of shape.made) files.add(f);
		}
		this.#keptPaths.set(space, { version, files });
		return [...files].sort();
	}

	/** Each space's path index (#41): built the first time it's asked for, then kept up as versions land. */
	readonly #pathIndex = new WeakMap<Space, { upTo: number; paths: Map<string, PathLife> }>();

	/** The files a version changed. `views` holds views by version, so a run of versions builds each once. */
	versionFiles(space: Space, version: number, views = new Map<number, ReadView>()): string[] {
		let cache = this.#filesCache.get(space);
		if (!cache) this.#filesCache.set(space, (cache = new Map()));
		const known = cache.get(version);
		if (known) return known;
		const kept = this.#keptFiles(space, version);
		if (kept) return kept;
		const shapes = this.#shapeCache.get(space)!;
		const p = space.versions[version]!;
		const viewAt = (v: number): ReadView => {
			let view = views.get(v);
			if (!view) views.set(v, (view = v < 0 ? new View(this.#deps.graph, []) : this.#deps.viewAt(space, v)));
			return view;
		};
		const before = viewAt(version - 1);
		const after = viewAt(version);
		// Net changes only, as show has them: a file made and removed again before the publish isn't one (#37).
		const touched = this.#deps.touchedFiles([...p.atoms, ...(p.dropped ?? [])], [before, after]);
		const files = [...touched].filter((path) => differs(before, after, path)).sort();
		this.keep(space, version, files, before, after);
		return files;
	}

	/**
	 * Keep a version's changed files, with its files made and taken out and its moves: worked out here, or as the
	 * version landed (version-files.ts, abso Capacity), which says which files existed before and after.
	 */
	keep(
		space: Space,
		version: number,
		files: string[],
		before: ReadView,
		after: ReadView,
		exists?: ReadonlyMap<string, readonly [boolean, boolean]>,
	): void {
		let cache = this.#filesCache.get(space);
		if (!cache) this.#filesCache.set(space, (cache = new Map()));
		let shapes = this.#shapeCache.get(space);
		if (!shapes) this.#shapeCache.set(space, (shapes = new Map()));
		const p = space.versions[version]!;
		cache.set(version, files);
		// Files made and taken out, and which of those are one file moved (#41): an atom that moves lines
		// names both files, and a binary or empty file moved keeps its blob.
		const had = (f: string) => exists?.get(f)?.[0] ?? before.hasFile(f);
		const has = (f: string) => exists?.get(f)?.[1] ?? after.hasFile(f);
		const made = files.filter((f) => !had(f) && has(f));
		const gone = files.filter((f) => had(f) && !has(f));
		const moves: [string, string][] = [];
		if (made.length > 0 && gone.length > 0) {
			const movers = new Set(this.#deps.graph.movers());
			const moving = p.atoms.filter((id) => movers.has(id)).map((id) => this.#deps.graph.filesOf(id));
			const taken = new Set<string>();
			for (const to of made) {
				const blob = after.attrs(to).blob;
				const from = gone.find(
					(g) =>
						!taken.has(g) &&
						(moving.some((fs) => fs.includes(g) && fs.includes(to)) ||
							(blob !== null && before.attrs(g).blob === blob)),
				);
				if (from !== undefined) taken.add(from), moves.push([from, to]);
			}
		}
		shapes.set(version, { made, gone, moves });
		this.#deps.shapes?.put(space.name, version, JSON.stringify({ stamp: shapeStamp(p), files, made, gone, moves }));
	}

	/** A version's files kept from an earlier load (#41), when the row describes this very version; into the caches. */
	#keptFiles(space: Space, version: number): string[] | undefined {
		let cache = this.#filesCache.get(space);
		if (!cache) this.#filesCache.set(space, (cache = new Map()));
		let shapes = this.#shapeCache.get(space);
		if (!shapes) this.#shapeCache.set(space, (shapes = new Map()));
		const known = cache.get(version);
		if (known) return known;
		const row = this.#deps.shapes?.get(space.name, version);
		if (row === undefined) return undefined;
		const kept = JSON.parse(row) as { stamp: string; files: string[] } & VersionShape;
		if (kept.stamp !== shapeStamp(space.versions[version]!)) return undefined;
		cache.set(version, kept.files);
		shapes.set(version, { made: kept.made, gone: kept.gone, moves: kept.moves });
		return kept.files;
	}

	/** A version's files made and taken out, and moves (#41). */
	versionShape(space: Space, version: number, views?: Map<number, ReadView>): VersionShape {
		const known = this.#shapeCache.get(space)?.get(version);
		if (known) return known;
		this.#filesCache.get(space)?.delete(version);
		this.versionFiles(space, version, views);
		return this.#shapeCache.get(space)!.get(version)!;
	}

	/**
	 * The space's path index (#41): for each path ever in it, the versions that
	 * changed it, and the versions that made it and took it out. The first ask
	 * after a restart walks every version, as a cold log over all of them does;
	 * later asks only walk the versions since.
	 */
	pathsOf(space: Space): Map<string, PathLife> {
		let index = this.#pathIndex.get(space);
		if (!index) this.#pathIndex.set(space, (index = { upTo: -1, paths: new Map() }));
		const views = new Map<number, ReadView>();
		// Shared's sets grow version by version, so walk them forward rather than build each from the
		// start; the views stay out of the cache, which they would only push other views from. A version
		// whose files are kept (#41) needs no views at all.
		let running: Set<AtomId> | undefined;
		let runningAt = -1;
		const setAt = (u: number): Set<AtomId> => {
			if (!running || runningAt > u) (running = new Set(u < 0 ? [] : this.#deps.at(space, u))), (runningAt = u);
			while (runningAt < u) {
				const q = space.versions[++runningAt]!;
				for (const id of q.atoms) running.add(id);
				for (const id of q.dropped ?? []) running.delete(id);
			}
			return running;
		};
		for (let v = index.upTo + 1; v <= last(space); v++) {
			// Persistent graphs use the indexed version reader; a raw View would
			// rebuild move scratch state and copy historical membership during a read.
			if (space.name === SHARED && !this.#deps.graph.hasOrderedChildren && !this.#keptFiles(space, v)) {
				if (v > 0 && !views.has(v - 1)) views.set(v - 1, new View(this.#deps.graph, new Set(setAt(v - 1))));
				views.set(v, new View(this.#deps.graph, new Set(setAt(v))));
			}
			const files = this.versionFiles(space, v, views);
			const shape = this.versionShape(space, v, views);
			views.delete(v - 1);
			const life = (path: string): PathLife => {
				let l = index!.paths.get(path);
				if (!l) index!.paths.set(path, (l = { changed: [], events: [] }));
				return l;
			};
			for (const f of files) life(f).changed.push(v);
			const from = new Map(shape.moves.map(([a, b]) => [b, a]));
			const to = new Map(shape.moves);
			for (const f of shape.made)
				life(f).events.push({ version: v, made: true, ...(from.has(f) ? { other: from.get(f)! } : {}) });
			for (const f of shape.gone)
				life(f).events.push({ version: v, made: false, ...(to.has(f) ? { other: to.get(f)! } : {}) });
			index.upTo = v;
		}
		return index.paths;
	}

	lastChange(space: Space, version: number): LastChange {
		const p = space.versions[version]!;
		return { version, agent: p.agent, time: p.time, message: p.message };
	}

	/** The newest version in a sorted list no later than `version`, or undefined. */
	static atOrBefore(list: readonly number[], version: number): number | undefined {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid]! <= version) lo = mid + 1;
			else hi = mid;
		}
		return lo > 0 ? list[lo - 1] : undefined;
	}

	/** The newest version in (from, to] that took a line out: one deleting it, or a drop of the change that wrote it. */
	removedIn(space: Space, from: number, to: number, line: LineId): { removed?: number } {
		const g = this.#deps.graph;
		const deleters = new Set(g.deletersOf(line));
		const writer = g.line(line)?.atom;
		for (let v = to; v > from; v--) {
			const p = space.versions[v]!;
			if (p.atoms.some((id) => deleters.has(id)) || (writer !== undefined && p.dropped?.includes(writer)))
				return { removed: v };
		}
		return {};
	}
}
