// Property: concurrent edits. Atoms written against the same older view
// conflict exactly when their claim keys overlap, and otherwise project to the
// same bytes in every acceptance order, equal to applying all their hunks to
// the old text at once.
//   PROP_SEED=<seed> PROP_CASES=1 node --test src/engine/test/concurrent.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Atom,
	type AtomId,
	type AtomInput,
	buildAtom,
	claimsOf,
	conflicts,
	diffLines,
	type EditInput,
	Graph,
	independent,
	keyOverlap,
	type Mode,
	splitLines,
	type TextEdit,
	View,
} from "../index.ts";

const textOf = (lines: readonly string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

import { EditGen, type Files, filesFromView, filesToRecord, sameFiles } from "./gen.ts";
import { Repo, Rng } from "./helpers.ts";

const BASE_SEED = Number(process.env.PROP_SEED ?? 20260621);
const CASES = Number(process.env.PROP_CASES ?? 250);

/** A hunk in terms of the old view's visible lines. start === end is a pure insertion at gap start. */
interface PlainHunk {
	readonly file: string;
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
}

interface Concurrent {
	readonly input: AtomInput;
	readonly hunks: readonly PlainHunk[];
	readonly describe: string;
}

/** Apply hunks from several atoms to the old text at once (the oracle). */
function applyAll(base: Files, hunks: readonly PlainHunk[]): Files {
	const out: Files = new Map(base);
	const byFile = new Map<string, PlainHunk[]>();
	for (const h of hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
	for (const [file, list] of byFile) {
		const old = base.get(file) ?? [];
		const inserts = new Map<number, readonly string[]>();
		const deleted = new Set<number>();
		const afterLine = new Map<number, readonly string[]>();
		for (const h of list) {
			if (h.start === h.end) {
				assert.ok(!inserts.has(h.start), "two non-conflicting insertions into one gap");
				inserts.set(h.start, h.lines);
			} else {
				for (let i = h.start; i < h.end; i++) {
					assert.ok(!deleted.has(i), "two non-conflicting atoms deleted the same line");
					deleted.add(i);
				}
				afterLine.set(h.end - 1, h.lines);
			}
		}
		const result: string[] = [];
		for (let p = 0; p <= old.length; p++) {
			result.push(...(inserts.get(p) ?? []));
			if (p < old.length) {
				if (!deleted.has(p)) result.push(old[p]!);
				result.push(...(afterLine.get(p) ?? []));
			}
		}
		if (result.length > 0) out.set(file, result);
		else out.delete(file);
	}
	return out;
}

/** One random single-hunk (sometimes two-file) concurrent edit against the old files. */
function concurrentEdit(gen: EditGen, rng: Rng, files: Files, index: number, deadPaths: readonly string[]): Concurrent {
	const hunks: PlainHunk[] = [];
	const edits: EditInput[] = [];
	const parts: string[] = [];
	const fresh = (n: number) => Array.from({ length: n }, () => gen.fresh());
	const usedFiles = new Set<string>();
	const addHunk = (): void => {
		const paths = [...files.keys()].filter((p) => !usedFiles.has(p) && files.get(p)!.length > 0).sort();
		const mode: Mode = rng.pick<Mode>(["both", "both", "after", "after", "before", "before", "wide"]);
		if (paths.length === 0 || rng.chance(0.08)) {
			const path = rng.pick(["c0.txt", "c1.txt", ...deadPaths]);
			if (usedFiles.has(path) || (files.get(path) ?? []).length > 0) return;
			usedFiles.add(path);
			const lines = fresh(rng.range(1, 3));
			hunks.push({ file: path, start: 0, end: 0, lines });
			edits.push({ file: path, old: "", new: `${lines.join("\n")}\n` });
			parts.push(`create ${path} ${JSON.stringify(lines)}`);
			return;
		}
		const path = rng.pick(paths);
		usedFiles.add(path);
		const old = files.get(path)!;
		const n = old.length;
		const roll = rng.int(3);
		let start: number;
		let end: number;
		let lines: string[];
		if (roll === 0) {
			start = end = rng.int(n + 1);
			lines = fresh(rng.range(1, 3));
		} else {
			start = rng.int(n);
			end = rng.range(start + 1, Math.min(n, start + 3));
			lines = roll === 1 ? fresh(rng.range(1, 3)) : [];
		}
		if (rng.chance(0.5)) {
			// As a text edit with context. With repeated lines several alignments
			// give the same text; step 2 of the spec (a line diff of old against
			// new) picks one, so the oracle's hunks come from that diff.
			const edit = gen.textEdit(path, old, start, end, lines, mode) as TextEdit;
			const at = textOf(old).indexOf(edit.old);
			const offset = textOf(old).slice(0, at).split("\n").length - 1;
			for (const h of diffLines(splitLines(edit.old), splitLines(edit.new))) {
				hunks.push({ file: path, start: offset + h.start, end: offset + h.end, lines: h.lines });
			}
			edits.push(edit);
		} else {
			hunks.push({ file: path, start, end, lines });
			edits.push({ file: path, start, end, lines, mode });
		}
		parts.push(
			`${roll === 0 ? "insert" : roll === 1 ? "replace" : "delete"} ${path}[${start},${end}) -> ${JSON.stringify(lines)} mode=${mode}`,
		);
	};
	addHunk();
	if (rng.chance(0.15)) addHunk();
	if (edits.length === 0) addHunk();
	const reliance = rng.chance(0.2) ? gen.reliance(files) : undefined;
	return {
		input: {
			author: `agent${index}`,
			message: `concurrent edit ${index}`,
			time: index,
			edits,
			...(reliance ? { reliesOn: [reliance] } : {}),
		},
		hunks,
		describe: parts.join(" + ") + (reliance ? ` reliesOn ${reliance.file}[${reliance.start},${reliance.end})` : ""),
	};
}

describe("property: concurrent edits", () => {
	it("conflict exactly when claim keys overlap; otherwise the same bytes in every acceptance order", (t) => {
		let nonTrivialMerges = 0;
		let conflictPairs = 0;
		for (let c = 0; c < CASES; c++) {
			const seed = BASE_SEED + c;
			const rng = new Rng(seed);
			const log: string[] = [];
			try {
				// An older view with some history (and tombstones) behind it.
				const gen = new EditGen(rng, { duplicates: rng.chance(0.5), wide: false });
				const initial = gen.initialFiles();
				const repo = Repo.init(filesToRecord(initial));
				log.push(`a0: ${JSON.stringify(filesToRecord(initial))}`);
				const baseSteps = rng.range(0, 12);
				for (let s = 0; s < baseSteps; s++) {
					const view = repo.view();
					const g = gen.next(filesFromView(view), view);
					if (!g) continue;
					try {
						const atom = repo.edit({ message: g.describe, edits: g.edits });
						log.push(`${atom.id}: ${g.describe}`);
					} catch (err) {
						if ((err as { code?: string }).code !== "empty-atom") throw err;
					}
				}
				const oldSet: ReadonlySet<AtomId> = new Set(repo.shared);
				const oldView = repo.view(oldSet);
				const oldFiles = filesFromView(oldView);
				const deadPaths = oldView.knownPaths().filter((p) => !oldView.hasFile(p));
				const saved = JSON.stringify(repo.graph);

				// k edits, each written against the same old view.
				const k = rng.range(2, 5);
				const edits = Array.from({ length: k }, (_, i) => concurrentEdit(gen, rng, oldFiles, i, deadPaths));
				const graph = repo.graph;
				const full = new Set(oldSet);
				const ids: AtomId[] = [];
				for (const e of edits) {
					const atom = buildAtom(new View(graph, oldSet), e.input);
					log.push(
						`${atom.id} (concurrent): ${e.describe} ${JSON.stringify(e.input.edits)} deletes ${atom.deletes.join(",") || "nothing"}`,
					);
					graph.add(atom);
					full.add(atom.id);
					ids.push(atom.id);
				}

				// They are pairwise independent, and depend only on the old view.
				for (const id of ids) for (const d of graph.atom(id).deps) assert.ok(oldSet.has(d), `${id} depends on ${d}`);
				// Conflicts: exactly the independent pairs with overlapping write/claim keys.
				const reported = new Set(conflicts(graph, full).map((x) => x.atoms.join(" ")));
				const expected = new Set<string>();
				const all = [...full].sort((a, b) => graph.atom(a).seq - graph.atom(b).seq);
				for (let i = 0; i < all.length; i++) {
					for (let j = i + 1; j < all.length; j++) {
						const a = all[i]!;
						const b = all[j]!;
						if (independent(graph, a, b) && keyOverlap(graph.atom(a), graph.atom(b)).length > 0)
							expected.add(`${a} ${b}`);
					}
				}
				assert.deepEqual([...reported].sort(), [...expected].sort(), "reported conflicts");
				for (const pair of expected) {
					const [a, b] = pair.split(" ");
					assert.ok(ids.includes(a!) && ids.includes(b!), `conflict ${pair} involves an atom of the old view`);
				}
				conflictPairs += expected.size;

				// The non-conflicting ones commute: same bytes in every acceptance order, equal to the oracle.
				const chosen: number[] = [];
				for (let i = 0; i < k; i++) {
					if (chosen.every((j) => !expected.has(`${ids[j]} ${ids[i]}`))) chosen.push(i);
				}
				if (chosen.length >= 2) nonTrivialMerges++;
				log.push(`merged without conflicts: ${chosen.map((i) => ids[i]).join(", ")}`);
				const want = filesToRecord(
					applyAll(
						oldFiles,
						chosen.flatMap((i) => edits[i]!.hunks),
					),
				);
				const orders = [chosen, [...chosen].reverse(), rng.shuffle(chosen)];
				for (const order of orders) {
					const fresh = Graph.fromJSON(JSON.parse(saved));
					const set = new Set(oldSet);
					for (const i of order) {
						const atom = buildAtom(new View(fresh, oldSet), edits[i]!.input);
						fresh.add(atom);
						set.add(atom.id);
					}
					assert.deepEqual(conflicts(fresh, set), [], `order ${order.join(",")} has conflicts`);
					assert.deepEqual(new View(fresh, set).files(), want, `acceptance order ${order.join(",")}`);
				}
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				assert.fail(
					`concurrent edits failed at seed ${seed} (rerun: PROP_SEED=${seed} PROP_CASES=1)\nsteps:\n  ${log.join("\n  ")}\n${detail}`,
				);
			}
		}
		// The generator must actually produce both outcomes.
		t.diagnostic(`${CASES} cases: ${nonTrivialMerges} merged two or more atoms, ${conflictPairs} conflicting pairs`);
		if (CASES >= 100) {
			assert.ok(nonTrivialMerges > CASES / 4, `only ${nonTrivialMerges} cases merged two or more atoms`);
			assert.ok(conflictPairs > CASES / 10, `only ${conflictPairs} conflicting pairs`);
		}
	});
});

function forCases(name: string, body: (rng: Rng, log: string[]) => void): void {
	for (let c = 0; c < CASES; c++) {
		const seed = BASE_SEED + c;
		const log: string[] = [];
		try {
			body(new Rng(seed), log);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			assert.fail(
				`${name} failed at seed ${seed} (rerun: PROP_SEED=${seed} PROP_CASES=1)\nsteps:\n  ${log.join("\n  ")}\n${detail}`,
			);
		}
	}
}

/** A repo with some live history behind it, so the old view has tombstones and siblings. */
function withHistory(rng: Rng, log: string[]): { repo: Repo; gen: EditGen } {
	const gen = new EditGen(rng, { duplicates: rng.chance(0.5), wide: false });
	const initial = gen.initialFiles();
	const repo = Repo.init(filesToRecord(initial));
	log.push(`a0: ${JSON.stringify(filesToRecord(initial))}`);
	const steps = rng.range(0, 12);
	for (let s = 0; s < steps; s++) {
		const view = repo.view();
		const files = filesFromView(view);
		const g = gen.next(files, view);
		if (!g || sameFiles(g.apply(files), files)) continue;
		const atom = repo.edit({ message: g.describe, edits: g.edits });
		log.push(`${atom.id}: ${g.describe}`);
	}
	return { repo, gen };
}

const pairKey = (a: AtomId, b: AtomId): string =>
	[a, b].sort((p, q) => Number(p.slice(1)) - Number(q.slice(1))).join(" ");

/** One concurrent splice, in line numbers of the old view (`n` lines in its file). */
interface Splice {
	readonly file: string;
	readonly start: number;
	readonly end: number;
	readonly mode: Mode;
	readonly n: number;
}

/**
 * The git floor, stated on line numbers alone (no keys): two replacements
 * touch when their ranges overlap; two insertions when they are at the same
 * place; an insertion and a replacement when the replacement covers a line
 * the insertion sits against. An insertion sits against the line above unless
 * in before mode and the line below unless in after mode; at the edge of the
 * file, against the one line there is.
 */
function touch(a: Splice, b: Splice): boolean {
	if (a.file !== b.file) return false;
	const isInsert = (h: Splice) => h.start === h.end;
	if (!isInsert(a) && !isInsert(b)) return a.start < b.end && b.start < a.end;
	if (isInsert(a) && isInsert(b)) return a.start === b.start;
	const [r, i] = isInsert(a) ? [b, a] : [a, b];
	const inR = (x: number) => x >= r.start && x < r.end;
	const p = i.start;
	const above = p > 0 && (i.mode !== "before" || p === i.n);
	const below = p < i.n && (i.mode !== "after" || p === 0);
	return (above && inR(p - 1)) || (below && inR(p));
}

// The concurrent property above compares conflicts() with keyOverlap(), the
// engine's own definition; this one checks the keys against line numbers.
describe("property: the git floor", () => {
	it("concurrent splice edits conflict exactly when their line ranges touch, in every mode", () => {
		let conflicting = 0;
		let clean = 0;
		forCases("git floor", (rng, log) => {
			const { repo, gen } = withHistory(rng, log);
			const oldSet = new Set(repo.shared);
			const oldView = repo.view(oldSet);
			const files = filesFromView(oldView);
			const paths = [...files.keys()].sort();
			if (paths.length === 0) return;
			const k = rng.range(2, 4);
			const splices = new Map<AtomId, Splice>();
			for (let i = 0; i < k; i++) {
				const file = rng.pick(paths);
				const n = files.get(file)!.length;
				const mode = rng.pick<Mode>(["both", "after", "before", "wide"]);
				const roll = rng.int(3);
				let start: number;
				let end: number;
				let add: string[];
				if (roll === 0) {
					start = end = rng.int(n + 1);
					add = [gen.fresh()];
				} else {
					start = rng.int(n);
					end = rng.range(start + 1, Math.min(n, start + 3));
					add = roll === 1 ? [gen.fresh(), gen.fresh()].slice(0, rng.range(1, 2)) : [];
				}
				const atom = buildAtom(new View(repo.graph, oldSet), {
					author: `agent${i}`,
					message: `${roll === 0 ? "insert" : roll === 1 ? "replace" : "delete"} ${file}[${start},${end}) mode=${mode}`,
					edits: [{ file, start, end, lines: add, mode }],
				});
				log.push(`${atom.id} (concurrent): ${atom.message}`);
				repo.graph.add(atom);
				repo.shared.add(atom.id);
				splices.set(atom.id, { file, start, end, mode, n });
			}
			const ids = [...splices.keys()];
			const expected: string[] = [];
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					if (touch(splices.get(ids[i]!)!, splices.get(ids[j]!)!)) expected.push(pairKey(ids[i]!, ids[j]!));
					else clean++;
				}
			}
			conflicting += expected.length;
			const reported = conflicts(repo.graph, repo.shared).map((c) => pairKey(c.atoms[0], c.atoms[1]));
			assert.deepEqual(reported.sort(), expected.sort());
		});
		if (CASES >= 100) {
			assert.ok(conflicting > CASES / 4, `only ${conflicting} touching pairs`);
			assert.ok(clean > CASES / 2, `only ${clean} clean pairs`);
		}
	});
});

// June: claim width is the lever. A narrow claim lets more run in parallel,
// a wide one serializes more.
describe("property: claim width", () => {
	it("narrowing a claim never adds a conflict and widening never removes one (after, before ⊆ both ⊆ wide)", () => {
		let narrowerHelped = 0;
		let widerBit = 0;
		forCases("claim width", (rng, log) => {
			const { repo, gen } = withHistory(rng, log);
			const oldView = repo.view(new Set(repo.shared));
			const files = filesFromView(oldView);
			// Concurrent atoms written against the same old view, some with reliances.
			const pool: Atom[] = [];
			for (let i = 0; i < 8; i++) {
				const g = gen.next(files, oldView);
				if (!g || sameFiles(g.apply(files), files)) continue;
				const reliance = rng.chance(0.2) ? gen.reliance(files) : undefined;
				pool.push(
					buildAtom(oldView, {
						author: `p${i}`,
						message: g.describe,
						edits: g.edits,
						...(reliance ? { reliesOn: [reliance] } : {}),
					}),
				);
			}
			// The subject: one hunk as a text edit with up to two lines of unchanged
			// context on each side (the context is what wide holds).
			const paths = [...files.keys()].sort();
			if (paths.length === 0) return;
			const file = rng.pick(paths);
			const all = files.get(file)!;
			const n = all.length;
			const insert = rng.chance(0.5);
			const i = insert ? rng.int(n + 1) : rng.int(n);
			const j = insert ? i : rng.range(i + 1, Math.min(n, i + 2));
			const add = insert ? [gen.fresh()] : rng.chance(0.3) ? [] : [gen.fresh()];
			const a = Math.max(0, i - rng.range(0, 2));
			const b = Math.min(n, j + rng.range(0, 2));
			const edit = gen.textEdit(file, all, i, j, add, "both") as { old: string; new: string };
			const text = (ls: readonly string[]) => (ls.length ? `${ls.join("\n")}\n` : "");
			const whole = text(all);
			const wider = { file, old: text(all.slice(a, b)), new: text([...all.slice(a, i), ...add, ...all.slice(j, b)]) };
			const unique = wider.old !== "" && whole.indexOf(wider.old) === whole.lastIndexOf(wider.old);
			const subject = unique ? wider : { file, old: edit.old, new: edit.new };
			log.push(`subject: ${file}[${i},${j}) -> ${JSON.stringify(add)} as ${JSON.stringify(subject)}`);
			const build = (mode: Mode) =>
				buildAtom(oldView, { author: "subject", message: "subject", edits: [{ ...subject, mode }] });
			const [after, before, both, wide] = (["after", "before", "both", "wide"] as const).map(build) as [
				Atom,
				Atom,
				Atom,
				Atom,
			];
			for (const v of [after, before, wide]) assert.deepEqual(v.writes, both.writes);
			const subset = (x: readonly string[], y: readonly string[], what: string) => {
				const ys = new Set(y);
				for (const s of x) assert.ok(ys.has(s), `${what}: ${s} missing`);
			};
			for (const [narrow, name] of [
				[after, "after"],
				[before, "before"],
			] as const) {
				subset(claimsOf(narrow), claimsOf(both), `claims ${name} ⊆ both`);
				subset(narrow.deps, both.deps, `deps ${name} ⊆ both`);
			}
			subset(claimsOf(both), claimsOf(wide), "claims both ⊆ wide");
			subset(both.deps, wide.deps, "deps both ⊆ wide");
			for (const other of pool) {
				const [hitAfter, hitBefore, hitBoth, hitWide] = [after, before, both, wide].map(
					(v) => keyOverlap(v, other).length > 0,
				);
				if (hitAfter || hitBefore) assert.ok(hitBoth, `a narrow mode conflicts with ${other.author} but both does not`);
				if (hitBoth) assert.ok(hitWide, `both conflicts with ${other.author} but wide does not`);
				if (hitBoth && !(hitAfter && hitBefore)) narrowerHelped++;
				if (!hitBoth && hitWide) widerBit++;
			}
		});
		// The lever must actually move in the generated cases.
		if (CASES >= 100) {
			assert.ok(narrowerHelped > 10, `a narrow mode avoided only ${narrowerHelped} conflicts that both had`);
			assert.ok(widerBit > 10, `wide added only ${widerBit} conflicts that both lacked`);
		}
	});
});
