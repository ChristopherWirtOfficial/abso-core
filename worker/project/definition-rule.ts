// The changed-definition rule (#11, #25), moved out of project.ts (abso issue
// 123): a draft collides with newer work that changed or removed the
// definition of a name the draft's own lines use. Plain reads of the graph and
// views; the project hands in who published an atom, and keeps the rule's
// cache for its life.

import { type AtomId, type Graph, joinLines, type LineId, type View } from "../../src/engine/index.ts";
import { type Origin, touchedFiles } from "./collisions.ts";
import { type Definition, definitionsIn, importsOf, usedNames } from "./definitions.ts";
import { codeOfLines, declaredIn, holdsNoCode } from "./names.ts";
import { definitionText } from "./news.ts";
import type { Collision } from "./project.ts";

export interface DefinitionCollision {
	/** For news: told once per name and version. */
	readonly key: string;
	/** The first newer atom that changed the definition. */
	readonly by: AtomId;
	readonly collision: Collision;
	readonly news: string;
}

/** Compare a name's definitions as text, in any order. */
export function signature(defs: readonly Definition[]): string {
	return defs
		.map((d) => `${d.file}\u0000${d.text}`)
		.sort()
		.join("\u0001");
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** Where one of an atom's inserted runs ends (its lines' k), and the node it hangs off. */
interface RunEnd {
	readonly end: number;
	readonly parent: string;
}

export class DefinitionRule {
	readonly #graph: Graph;
	readonly #origin: (atom: AtomId, spaceName: string) => Origin;
	readonly #replacedCache = new Map<string, ReadonlySet<string>>();

	constructor(graph: Graph, origin: (atom: AtomId, spaceName: string) => Origin) {
		this.#graph = graph;
		this.#origin = origin;
	}

	/**
	 * The names used on the lines a new line's change replaced (#25): when the
	 * run holding the line hangs off a line its own atom deleted, that run
	 * replaced the block of lines the atom deleted just before it in `base`.
	 * A pure insertion replaced nothing.
	 */
	#replacedNames(line: LineId, base: View, runsOf: Map<AtomId, readonly RunEnd[]>): ReadonlySet<string> {
		const g = this.#graph;
		const info = g.line(line);
		if (!info) return EMPTY_NAMES;
		const atom = g.atom(info.atom);
		// Where each of the atom's runs ends, worked out once per check (abso issue 158): reading a run's
		// lines can mean reading its text back from the log, so not once per line of a big change.
		let runs = runsOf.get(atom.id);
		if (!runs) {
			let k = 0;
			runs = atom.inserts.map((run) => ({ end: (k += run.lines.length), parent: run.parent }));
			runsOf.set(atom.id, runs);
		}
		const parent = runs.find((r) => info.k < r.end)?.parent;
		if (parent === undefined || parent.startsWith("^") || !g.deletersOf(parent).includes(atom.id)) return EMPTY_NAMES;
		const key = `${atom.id} ${parent}`;
		let names = this.#replacedCache.get(key);
		if (!names) {
			const file = base.fileOf(parent);
			const seq = base.sequence(file);
			const out = new Set<string>();
			for (let at = base.sequenceIndex(file, parent); at >= 0; at--) {
				const l = seq[at]!;
				if (!g.deletersOf(l.id).includes(atom.id)) {
					if (l.visible) break; // the block ends at a line the change kept
					continue; // a line deleted before: not part of the block
				}
				for (const name of usedNames(l.text)) out.add(name);
			}
			names = out;
			this.#replacedCache.set(key, names);
		}
		return names;
	}

	/**
	 * Names the `draft` atoms' lines in `view` use whose definition changed
	 * between `baseView` and `nowView`, by an atom of `newer`. A name the
	 * draft declares itself is its own. A changed definition is any difference
	 * in the text of the name's definitions (see definitions.ts), including one
	 * that disappeared; a use that imports the name, or sits in a file that
	 * defines it, only counts that definition.
	 */
	collisions(
		draft: ReadonlySet<AtomId>,
		view: View,
		baseView: View,
		nowView: View,
		newer: ReadonlySet<AtomId>,
		spaceName: string,
	): DefinitionCollision[] {
		if (draft.size === 0 || newer.size === 0) return [];
		const uses = new Map<string, { file: string; index: number }[]>();
		const declared = new Set<string>();
		const runsOf = new Map<AtomId, readonly RunEnd[]>();
		// Only files the draft wrote lines in can hold its lines.
		const draftFiles = touchedFiles(this.#graph, draft, [view]);
		for (const file of [...draftFiles].sort()) {
			if (holdsNoCode(file) || !view.hasFile(file)) continue;
			const visible = view.lines(file);
			if (!visible.some((l) => draft.has(l.atom))) continue;
			const code = codeOfLines(visible.map((l) => l.text));
			visible.forEach((line, i) => {
				if (!draft.has(line.atom)) return;
				for (const name of declaredIn(code[i]!)) declared.add(name);
				// Only names the change added: a use already on the lines it replaced is not the draft's to answer for.
				const before = this.#replacedNames(line.id, baseView, runsOf);
				for (const name of usedNames(code[i]!)) {
					if (before.has(name)) continue;
					const list = uses.get(name);
					if (list) list.push({ file, index: i });
					else uses.set(name, [{ file, index: i }]);
				}
			});
		}
		for (const name of declared) uses.delete(name);
		if (uses.size === 0) return [];

		// A definition can only have changed in a file the newer work touched.
		const touched = touchedFiles(this.#graph, newer, [baseView, nowView]);
		const baseDefs = definitionsIn(baseView, touched);
		const nowDefs = definitionsIn(nowView, touched);
		const out: DefinitionCollision[] = [];
		for (const [name, where] of [...uses].sort(([a], [b]) => (a < b ? -1 : 1))) {
			// Which definitions the uses mean: the file each use imports the name
			// from, or its own file when it defines the name at the top level. A
			// use with neither (a local, a parameter, a global, a name another
			// language brings in some other way) means none: the rule only speaks
			// when it knows which definition a use means.
			const scope = new Set<string>();
			for (const w of new Set(where.map((x) => x.file))) {
				const from = importsOf(view, w).get(name) ?? (definitionsIn(view, [w]).has(name) ? w : undefined);
				if (from !== undefined) scope.add(from);
			}
			if (scope.size === 0) continue;
			const inScope = (d: Definition): boolean => scope.has(d.file);
			const before = baseDefs.get(name)?.filter(inScope);
			if (!before?.length) continue; // not defined in what the drafter saw: nothing it relies on
			const after = (nowDefs.get(name) ?? []).filter(inScope);
			if (signature(before) === signature(after)) continue;
			// Who changed it: newer writers of the new definition's lines, or newer deleters of the old one's.
			const by = new Set<AtomId>();
			for (const d of after)
				for (const line of d.lines) if (newer.has(this.#graph.line(line)!.atom)) by.add(this.#graph.line(line)!.atom);
			for (const d of before)
				for (const line of d.lines) for (const x of this.#graph.deletersOf(line)) if (newer.has(x)) by.add(x);
			const first = [...by].sort((p, q) => this.#graph.atom(p).seq - this.#graph.atom(q).seq)[0];
			if (first === undefined) continue;
			const origin = this.#origin(first, spaceName);
			const file = where[0]!.file;
			const indexes = where.filter((w) => w.file === file).map((w) => w.index);
			const lo = Math.min(...indexes);
			const hi = Math.max(...indexes);
			const visible = view.lines(file);
			const def = after[0];
			const theirs = def
				? { file: def.file, lines: [def.start + 1, def.end] as [number, number], text: `${def.text}\n` }
				: { file: before[0]!.file, lines: [before[0]!.start + 1, before[0]!.start] as [number, number], text: "" };
			const collision: Collision = {
				kind: "definition",
				name,
				file,
				yours: { lines: [lo + 1, hi + 1], text: joinLines(visible.slice(lo, hi + 1).map((l) => l.text)) },
				theirs: { ...theirs, ...origin },
			};
			const change = def
				? `changes the definition of ${name} (${def.file} line ${def.start + 1})`
				: `removes the definition of ${name}`;
			out.push({
				key: `def ${name} ${origin.draft ?? ""} ${origin.version}`,
				by: first,
				collision,
				news: definitionText(origin, change, name, file, lo + 1),
			});
		}
		return out;
	}
}
