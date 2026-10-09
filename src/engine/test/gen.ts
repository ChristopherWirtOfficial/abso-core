// Random edit generation for property tests. Everything is driven by a seeded
// Rng; a failing case is reproduced by its seed alone.

import { canonicalText, type EditInput, type LineRange, type Mode, splitLines, type View } from "../index.ts";
import type { Rng } from "./helpers.ts";

/** path -> visible lines. The plain-text model the engine is checked against. */
export type Files = Map<string, string[]>;

export function filesFromView(view: View): Files {
	const out: Files = new Map();
	for (const path of view.paths())
		out.set(
			path,
			view.lines(path).map((l) => l.text),
		);
	return out;
}

export function filesToRecord(files: Files): Record<string, string> {
	const out: Record<string, string> = {};
	for (const path of [...files.keys()].sort()) {
		const lines = files.get(path)!;
		if (lines.length > 0) out[path] = lines.join("\n") + "\n";
	}
	return out;
}

function textOf(lines: readonly string[]): string {
	return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function occurrences(text: string, needle: string): number {
	let count = 0;
	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) count++;
	return count;
}

/** One generated atom's worth of edits, plus what it does to plain text. */
export interface GenEdit {
	readonly edits: EditInput[];
	readonly describe: string;
	/** Apply to plain text (returns a new map). */
	readonly apply: (files: Files) => Files;
}

export interface GenOptions {
	/** Use a small alphabet so lines repeat (exercises unique matching and LCS). */
	readonly duplicates: boolean;
	/** Allow wide mode. */
	readonly wide: boolean;
}

/** Splice regions on one file, applied simultaneously in (start, end, order) order. */
export interface SpliceRegion {
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
}

export function applySplices(lines: readonly string[], regions: readonly SpliceRegion[]): string[] {
	const sorted = regions
		.map((r, order) => ({ ...r, order }))
		.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
	const out: string[] = [];
	let pos = 0;
	for (const r of sorted) {
		if (r.start < pos) throw new Error("overlapping splice regions in generator");
		out.push(...lines.slice(pos, r.start), ...r.lines);
		pos = r.end;
	}
	out.push(...lines.slice(pos));
	return out;
}

export class EditGen {
	readonly rng: Rng;
	readonly opts: GenOptions;
	#token = 0;
	#deletedPaths: string[] = [];
	#fileCounter = 0;

	constructor(rng: Rng, opts: GenOptions) {
		this.rng = rng;
		this.opts = opts;
	}

	fresh(): string {
		return `t${this.#token++}`;
	}

	line(): string {
		if (this.opts.duplicates && this.rng.chance(0.6)) {
			return this.rng.pick(["a", "b", "c", "", "{", "}", "  x", "y y", "a b"]);
		}
		return this.fresh();
	}

	newLines(min: number, max: number): string[] {
		const n = this.rng.range(min, max);
		return Array.from({ length: n }, () => this.line());
	}

	mode(): Mode {
		const modes: Mode[] = this.opts.wide ? ["both", "after", "before", "wide"] : ["both", "after", "before"];
		return this.rng.pick(modes);
	}

	initialFiles(): Files {
		const files: Files = new Map();
		const count = this.rng.range(1, 3);
		for (let i = 0; i < count; i++) {
			const path = this.rng.chance(0.3) ? `dir/f${i}.txt` : `f${i}.txt`;
			const lines = this.newLines(0, 8);
			if (lines.length > 0) files.set(path, lines);
		}
		if (files.size === 0) files.set("f0.txt", this.newLines(1, 4));
		return files;
	}

	/** Gaps p (0..n) that have tombstones between visible line p-1 and p. */
	static tombstoneGaps(view: View | undefined, path: string): number[] {
		if (!view) return [];
		const gaps = new Set<number>();
		let seen = 0;
		for (const line of view.sequence(path)) {
			if (line.visible) seen++;
			else gaps.add(seen);
		}
		return [...gaps];
	}

	/** A gap position, biased toward gaps with tombstones. */
	gap(n: number, tombs: readonly number[]): number {
		if (tombs.length > 0 && this.rng.chance(0.5)) return Math.min(this.rng.pick(tombs), n);
		return this.rng.int(n + 1);
	}

	/** A non-empty range [i, j), biased to start or end next to a tombstone. */
	range(n: number, tombs: readonly number[]): [number, number] {
		let i: number;
		if (tombs.length > 0 && this.rng.chance(0.5)) {
			const g = Math.min(this.rng.pick(tombs), n);
			i = this.rng.chance(0.5) && g > 0 ? g - 1 : Math.min(g, n - 1);
		} else {
			i = this.rng.int(n);
		}
		const j = this.rng.range(i + 1, Math.min(n, i + 4));
		return [i, j];
	}

	/**
	 * A text edit replacing lines [start, end) with `lines`, with enough context
	 * that `old` matches exactly once.
	 */
	textEdit(
		path: string,
		all: readonly string[],
		start: number,
		end: number,
		lines: readonly string[],
		mode: Mode,
	): EditInput {
		let a = start;
		let b = end;
		if (a === b) {
			if (a > 0 && (b === all.length || this.rng.chance(0.5))) a--;
			else b++;
		}
		const text = textOf(all);
		while (occurrences(text, textOf(all.slice(a, b))) !== 1) {
			if (a > 0 && (b === all.length || this.rng.chance(0.5))) a--;
			else b++;
		}
		return {
			file: path,
			old: textOf(all.slice(a, b)),
			new: textOf([...all.slice(a, start), ...lines, ...all.slice(end, b)]),
			mode,
		};
	}

	/** One random atom's edits against `files` (the plain model of `view`). */
	next(files: Files, view?: View): GenEdit | undefined {
		const paths = [...files.keys()].filter((p) => files.get(p)!.length > 0).sort();
		const roll = this.rng.int(100);
		if (paths.length === 0 || roll < 8) return this.create(files);
		const path = this.rng.pick(paths);
		const lines = files.get(path)!;
		const n = lines.length;
		const tombs = EditGen.tombstoneGaps(view, path);
		const mode = this.mode();
		const useText = this.rng.chance(0.5);
		const spliceTo = (start: number, end: number, add: readonly string[], what: string): GenEdit => ({
			edits: [
				useText ? this.textEdit(path, lines, start, end, add, mode) : { file: path, start, end, lines: add, mode },
			],
			describe: `${what} ${path}[${start},${end}) -> ${JSON.stringify(add)} mode=${mode}${useText ? " (text)" : " (splice)"}`,
			apply: (fs) => replaceFile(fs, path, applySplices(fs.get(path) ?? [], [{ start, end, lines: add }])),
		});

		if (roll < 30) {
			const p = this.gap(n, tombs);
			return spliceTo(p, p, this.newLines(1, 4), "insert");
		}
		if (roll < 50) {
			const [i, j] = this.range(n, tombs);
			return spliceTo(i, j, this.newLines(1, 4), "replace");
		}
		if (roll < 62) {
			const [i, j] = this.range(n, tombs);
			return spliceTo(i, j, [], "delete");
		}
		if (roll < 77) return this.partial(path, lines, mode);
		if (roll < 82) {
			const all = textOf(lines);
			return {
				edits: [{ file: path, old: all, new: "", mode }],
				describe: `delete-file ${path}`,
				apply: (fs) => {
					this.#deletedPaths.push(path);
					return replaceFile(fs, path, []);
				},
			};
		}
		return this.multi(files, paths);
	}

	create(files: Files): GenEdit {
		const reuse = this.#deletedPaths.filter((p) => (files.get(p) ?? []).length === 0);
		const path = reuse.length > 0 && this.rng.chance(0.6) ? this.rng.pick(reuse) : `new${this.#fileCounter++}.txt`;
		const lines = this.newLines(1, 5);
		return {
			edits: [{ file: path, old: "", new: textOf(lines) }],
			describe: `create ${path} ${JSON.stringify(lines)}`,
			apply: (fs) => replaceFile(fs, path, lines),
		};
	}

	/** Replace part of a line (maybe running into the next line) with text that may add or remove line breaks. */
	partial(path: string, lines: readonly string[], mode: Mode): GenEdit | undefined {
		const candidates = lines.map((t, i) => (t.length > 0 ? i : -1)).filter((i) => i >= 0);
		if (candidates.length === 0) return undefined;
		const i = this.rng.pick(candidates);
		const t = lines[i]!;
		const c1 = this.rng.int(t.length);
		let old = t.slice(c1, this.rng.range(c1 + 1, t.length));
		if (this.rng.chance(0.3) && i + 1 < lines.length) {
			const next = lines[i + 1]!;
			old = t.slice(c1) + "\n" + next.slice(0, this.rng.int(next.length + 1));
		}
		const replacement = this.rng.pick(["", "Z", "q\nr", "\n", "w\n", "yy", "Z\nZ", this.fresh()]);
		const text = textOf(lines);
		if (occurrences(text, old) !== 1 || old === replacement) return undefined;
		const at = text.indexOf(old);
		return {
			edits: [{ file: path, old, new: replacement, mode }],
			describe: `partial ${path} ${JSON.stringify(old)} -> ${JSON.stringify(replacement)} mode=${mode}`,
			apply: (fs) => {
				const cur = textOf(fs.get(path) ?? []);
				const next = canonicalText(cur.slice(0, at) + replacement + cur.slice(at + old.length));
				return replaceFile(fs, path, splitLines(next));
			},
		};
	}

	/** Two or three splices in one atom, across one or two files. */
	multi(files: Files, paths: readonly string[]): GenEdit {
		const chosen =
			this.rng.chance(0.5) && paths.length > 1 ? this.rng.shuffle(paths).slice(0, 2) : [this.rng.pick(paths)];
		const edits: EditInput[] = [];
		const perFile = new Map<string, SpliceRegion[]>();
		for (const path of chosen) {
			const n = files.get(path)!.length;
			const count = chosen.length === 1 ? this.rng.range(2, 3) : this.rng.range(1, 2);
			const cuts = Array.from({ length: count * 2 }, () => this.rng.int(n + 1)).sort((a, b) => a - b);
			const regions: SpliceRegion[] = [];
			for (let r = 0; r < count; r++) {
				const start = cuts[2 * r]!;
				const end = cuts[2 * r + 1]!;
				const add = this.newLines(start === end ? 1 : 0, 3);
				regions.push({ start, end, lines: add });
				edits.push({ file: path, start, end, lines: add, mode: this.mode() });
			}
			perFile.set(path, regions);
		}
		return {
			edits,
			describe: `multi ${[...perFile].map(([p, rs]) => `${p}:${rs.map((r) => `[${r.start},${r.end})->${JSON.stringify(r.lines)}`).join(",")}`).join(" ")}`,
			apply: (fs) => {
				let out = fs;
				for (const [path, regions] of perFile) out = replaceFile(out, path, applySplices(out.get(path) ?? [], regions));
				return out;
			},
		};
	}

	/** A random non-empty range of some file, for reliesOn. */
	reliance(files: Files): LineRange | undefined {
		const paths = [...files.keys()].filter((p) => files.get(p)!.length > 0);
		if (paths.length === 0) return undefined;
		const path = this.rng.pick(paths);
		const n = files.get(path)!.length;
		const start = this.rng.int(n);
		return { file: path, start, end: this.rng.range(start + 1, Math.min(n, start + 3)) };
	}
}

function replaceFile(files: Files, path: string, lines: string[]): Files {
	const out: Files = new Map(files);
	if (lines.length === 0) out.delete(path);
	else out.set(path, lines);
	return out;
}

export function sameFiles(a: Files, b: Files): boolean {
	return JSON.stringify(filesToRecord(a)) === JSON.stringify(filesToRecord(b));
}
