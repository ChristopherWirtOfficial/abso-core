// A version of shared without some earlier versions: the files that version's atoms make when the atoms those
// versions added are left out. Shared doesn't change, and nothing is written: it is a read. The atoms keep
// their ids and authors; nothing is replayed or renumbered.
//
// The set left is checked exactly as asked. When a kept version builds on a left-out one, the answer is a
// refusal naming that chain, the files and the wider set that would work. It is never widened silently, and
// never closed again by a helper that would bring a left-out atom back.

import { type AtomId, type Graph, type ReadView, View } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type { FileChange } from "./project-types.ts";
import type { Space } from "./spaces.ts";
import { treeHash } from "./tree.ts";
import { changesBetween, modesOf } from "./view-changes.ts";

/** What a version without others needs from a project. */
export interface WithoutHost {
	readonly graph: Graph;
	shared(): Space;
	needInit(): void;
	checkVersion(space: Space, version: number): void;
	viewAt(space: Space, version: number): ReadView;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	/** The set as a view of it reads it: with any discarded atom a publish still depends on. */
	closed(set: ReadonlySet<AtomId>): ReadonlySet<AtomId>;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
}

/** A version, as the answer names it. */
export interface VersionNamed {
	version: number;
	agent: string;
	message: string;
}

/** A kept version that builds on a left-out one: the versions it builds on, and in which files. */
export interface BuildsOn extends VersionNamed {
	needs: { version: number; files: string[] }[];
}

export type WithoutAnswer =
	| {
			ok: true;
			version: number;
			without: VersionNamed[];
			/** Every file that differs from the version as it is: before, in it; after, without the others. */
			files: FileChange[];
			/** The tree hash (tree.ts) of every file without them: the same ask always gives the same hash. */
			tree: string;
	  }
	| {
			ok: false;
			version: number;
			without: VersionNamed[];
			/** Kept versions that build on left-out ones, oldest first: each with what it builds on. */
			dependents: BuildsOn[];
			/** The versions to leave out for it to work: these and every dependent. A suggestion, never applied. */
			suggestion: number[];
	  };

/**
 * Version `version` of shared without the versions in `without`: what its
 * files are when those versions' atoms are left out. Refused, with the
 * chain, when a version kept builds on one left out.
 */
export function without(host: WithoutHost, version: number, versions: readonly number[]): WithoutAnswer {
	host.needInit();
	const shared = host.shared();
	if (!Number.isInteger(version)) throw new ProjectError("bad-request", "version must be a number");
	host.checkVersion(shared, version);
	if (!Array.isArray(versions) || versions.length === 0)
		throw new ProjectError("bad-request", "without needs the versions to leave out");
	const g = host.graph;
	const asked = [...new Set(versions)].toSorted((a, b) => a - b);
	const base = host.at(shared, version);
	const out = new Set<AtomId>();
	for (const v of asked) {
		if (!Number.isInteger(v) || v < 1)
			throw new ProjectError(
				"bad-request",
				`there is no version ${String(v)} to leave out (version 0 is the start, which everything builds on)`,
			);
		if (v > version)
			throw new ProjectError("bad-request", `version ${v} comes after version ${version}, so it isn't in it`);
		const p = shared.versions[v]!;
		if (p.atoms.length === 0)
			throw new ProjectError(
				"bad-request",
				`version ${v} added nothing (it is a drop), so there is nothing to leave out`,
			);
		const left = p.atoms.filter((id) => base.has(id));
		if (left.length === 0)
			throw new ProjectError(
				"bad-request",
				`version ${v} isn't in version ${version}: version ${shared.droppedIn.get(p.atoms[0]!)} dropped it`,
			);
		for (const id of left) out.add(id);
	}
	const describe = (v: number): VersionNamed => ({
		version: v,
		agent: shared.versions[v]!.agent,
		message: shared.versions[v]!.message,
	});
	const kept = new Set<AtomId>();
	for (const id of host.closed(base)) if (!out.has(id)) kept.add(id);

	// Everything kept that builds on what is left out, and the step that reached it.
	const gone = new Set(out);
	const steps: { from: AtomId; to: AtomId }[] = [];
	const stack = [...out];
	while (stack.length > 0) {
		const id = stack.pop()!;
		for (const d of g.dependentsOf(id)) {
			if (!kept.has(d)) continue;
			steps.push({ from: d, to: id });
			if (gone.has(d)) continue;
			gone.add(d);
			stack.push(d);
		}
	}
	if (gone.size > out.size) {
		// A discarded atom a publish still needs has no version of its own: it counts with the version that needs it.
		const versionOf = (id: AtomId): number | undefined => shared.publishedIn.get(id);
		const needs = new Map<number, Map<number, Set<string>>>();
		const resolved = (id: AtomId, seen = new Set<AtomId>()): number[] => {
			const v = versionOf(id);
			if (v !== undefined) return [v];
			if (seen.has(id)) return [];
			seen.add(id);
			return [...new Set(steps.filter((s) => s.from === id).flatMap((s) => resolved(s.to, seen)))];
		};
		for (const { from, to } of steps) {
			const dv = versionOf(from);
			if (dv === undefined) continue;
			const files = g.filesOf(from).length > 0 ? g.filesOf(from) : g.filesOf(to);
			for (const nv of resolved(to)) {
				if (nv === dv) continue;
				let of = needs.get(dv);
				if (!of) needs.set(dv, (of = new Map()));
				let set = of.get(nv);
				if (!set) of.set(nv, (set = new Set()));
				for (const f of files) set.add(f);
			}
		}
		const dependents = [...needs.keys()]
			.filter((v) => !asked.includes(v))
			.toSorted((a, b) => a - b)
			.map((v) => ({
				...describe(v),
				needs: [...needs.get(v)!]
					.toSorted(([a], [b]) => a - b)
					.map(([n, files]) => ({ version: n, files: [...files].toSorted() })),
			}));
		return {
			ok: false,
			version,
			without: asked.map(describe),
			dependents,
			suggestion: [...new Set([...asked, ...dependents.map((d) => d.version)])].toSorted((a, b) => a - b),
		};
	}

	// The set is checked; the engine's View refuses one that isn't closed, so nothing left out comes back.
	const before = host.viewAt(shared, version);
	const after = new View(g, kept);
	const files = changesBetween(before, after, host.touchedFiles(out, [before, after]));
	const all = after.paths();
	const blobs: Record<string, string> = {};
	const texts: Record<string, string> = {};
	for (const path of all) {
		const blob = after.attrs(path).blob;
		if (blob !== null) blobs[path] = blob;
		else texts[path] = after.text(path);
	}
	const modes = modesOf(after);
	return {
		ok: true,
		version,
		without: asked.map(describe),
		files,
		tree: treeHash({ files: texts, blobs, modes }),
	};
}
