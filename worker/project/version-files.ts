// Each version of shared's changed files, worked out as the version lands from what it touched (disk-first 2;
// abso Capacity). The log, a path's history and the tree read these lists; working them out from two layouts of every
// touched file per version cost game's whole history 460 s to adopt. Here a version costs about its own size:
// - a file it touched differs when its visible lines' count or texts changed, or its mode or blob did;
// - whether a file exists before and after comes from a running count of each file's visible lines;
// - only a version whose added and removed lines have the very same texts, or one with moves, drops or a change to
//   shared's closure, is laid out as before.
// The answers are exactly differs() in view-changes.ts.

import { type AtomId, type Graph, type ReadView, View } from "../../src/engine/index.ts";
import type { GraphStateStorage } from "../../src/engine/state-source.ts";
import { touchedFiles } from "./collisions.ts";
import type { Published } from "./spaces.ts";
import { differs } from "./view-changes.ts";

const COUNTS = "head-visible";
const META = "head-visible:meta";

/** The shared version the running counts describe, or undefined when this writer keeps none. */
export function countedVersion(storage: GraphStateStorage): number | undefined {
	return storage.read(META, "version") as number | undefined;
}

export interface VersionFilesHost {
	readonly storage: GraphStateStorage;
	readonly graph: Graph;
	/** Shared's set at a version (closed) and its view. */
	at(version: number): ReadonlySet<AtomId>;
	viewAt(version: number): ReadView;
	empty(): ReadView;
	/** Whether shared's closure changed at this version (spaces.ts). */
	closureChangedAt(version: number): boolean;
}

/** A file's visible lines in a view: a laid-out count, for the slow path. */
function visibleCount(view: ReadView, path: string): number {
	const counted = (view as { visibleCount?(path: string): number }).visibleCount;
	return counted ? counted.call(view, path) : view.lines(path).length;
}

/** The changed files of shared's version `v`, sorted, and which existed before and after; the running counts moved to `v`. */
export function versionFiles(
	host: VersionFilesHost,
	p: Published,
): { files: string[]; exists?: Map<string, readonly [boolean, boolean]> } {
	const { storage, graph } = host;
	const v = p.version;
	const counted = countedVersion(storage);
	const atoms = [...p.atoms, ...(p.dropped ?? [])];
	const before = v === 0 ? host.empty() : host.viewAt(v - 1);
	const after = host.viewAt(v);
	const fast =
		v > 0 &&
		counted === v - 1 &&
		!p.dropped?.length &&
		!p.atoms.some((id) => graph.atom(id).moves?.length) &&
		!host.closureChangedAt(v);
	// The same moves as the version before: share them, and where lines sit, instead of resolving them again.
	if (fast && before instanceof View && after instanceof View) after.shareMoves(before);
	const touched = touchedFiles(graph, atoms, [before, after]);
	let files: string[];
	if (!fast) {
		files = [...touched].filter((path) => differs(before, after, path)).sort();
		// Counts start with the first version; a writer adopted before has none and keeps none.
		if (counted === v - 1 || (v === 0 && counted === undefined)) {
			for (const path of files) storage.write(COUNTS, path, visibleCount(after, path));
			storage.write(META, "version", v);
		}
		return { files };
	}
	const beforeSet = host.at(v - 1);
	const afterSet = host.at(v);
	const visibleIn = (set: ReadonlySet<AtomId>, n: number) => {
		for (const seq of graph.eachDeleterSeqOf(n)) if (set.has(graph.idOfSeq(seq))) return false;
		return true;
	};
	const fileOf = (view: ReadView, line: string, n: number) =>
		view.hasMoves() ? view.fileOf(line) : graph.writtenIn(n);
	// Per file: visible lines added minus removed, and the texts' balance.
	const changes = new Map<string, { net: number; texts: Map<string, number>; lines: number }>();
	const change = (path: string) => {
		let c = changes.get(path);
		if (!c) changes.set(path, (c = { net: 0, texts: new Map(), lines: 0 }));
		return c;
	};
	for (const id of p.atoms) {
		for (const line of graph.eachInsertedLine(id)) {
			const n = graph.lineN(line);
			if (!visibleIn(afterSet, n)) continue;
			const c = change(fileOf(after, line, n));
			const text = graph.textOf(n);
			c.net++;
			c.lines++;
			c.texts.set(text, (c.texts.get(text) ?? 0) + 1);
		}
		for (const line of graph.deletedLines(id)) {
			const n = graph.lineN(line);
			if (!beforeSet.has(graph.idOfSeq(graph.writerSeqOf(n))) || !visibleIn(beforeSet, n)) continue;
			const c = change(fileOf(before, line, n));
			const text = graph.textOf(n);
			c.net--;
			c.lines++;
			c.texts.set(text, (c.texts.get(text) ?? 0) - 1);
		}
	}
	files = [];
	const exists = new Map<string, readonly [boolean, boolean]>();
	for (const path of touched) {
		const was = (storage.read(COUNTS, path) as number | undefined) ?? 0;
		const c = changes.get(path);
		const now = was + (c?.net ?? 0);
		const b = before.attrs(path);
		const a = after.attrs(path);
		const had = b.exists || b.link !== null || b.blob !== null || was > 0;
		const has = a.exists || a.link !== null || a.blob !== null || now > 0;
		let differ = had !== has || b.exec !== a.exec || b.link !== a.link || b.blob !== a.blob;
		if (!differ && had && c && c.lines > 0) {
			// Different texts in or out: the file's lines changed. The same texts in and out: compare the files.
			differ = [...c.texts.values()].some((count) => count !== 0) || !before.sameText(path, after);
		}
		if (differ) {
			files.push(path);
			exists.set(path, [had, has]);
		}
		if (now !== was) storage.write(COUNTS, path, now);
	}
	storage.write(META, "version", v);
	return { files: files.sort(), exists };
}
