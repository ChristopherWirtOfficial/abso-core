// Property tests over random edit histories (docs/prototype.md, "Property tests").
// Seeded: a failure prints its seed; rerun one case with
//   PROP_SEED=<seed> PROP_CASES=1 node --test src/engine/test/properties.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AtomId,
	type AtomInput,
	buildAtom,
	type Conflict,
	checkDraft,
	conflicts,
	type DraftReport,
	Graph,
	isStartNode,
	unresolvedConflicts,
	View,
	writerOf,
} from "../index.ts";
import { EditGen, type Files, filesFromView, filesToRecord, sameFiles } from "./gen.ts";
import { Repo, Rng } from "./helpers.ts";

const BASE_SEED = Number(process.env["PROP_SEED"] ?? 20260621);
const CASES = Number(process.env["PROP_CASES"] ?? 250);

/** Run `body` once per seed; on failure report the seed and the steps taken. */
export function forCases(name: string, body: (rng: Rng, log: string[]) => void): void {
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

interface SimOptions {
	readonly duplicates: boolean;
	/** Allow wide mode and reliesOn (explicit holds). */
	readonly holds: boolean;
	/** Probability that an atom is written against an older snapshot instead of the shared set. */
	readonly pinned: number;
}

/**
 * A random history: each step builds one atom and accepts it into the shared
 * set. Unpinned atoms are written against the full current projection and
 * also applied to a plain-text model (`plain`), which stays the ground truth
 * as long as no pinned atom has been accepted.
 */
class Sim {
	readonly rng: Rng;
	readonly log: string[];
	readonly opts: SimOptions;
	readonly gen: EditGen;
	readonly repo: Repo;
	plain: Files;
	plainIsTruth = true;
	snapshots: Set<AtomId>[] = [];
	/** The set each accepted atom was written against. */
	viewOf = new Map<AtomId, ReadonlySet<AtomId>>();
	/** The plain-text result of each atom's edit applied to the projection of its view. */
	expected = new Map<AtomId, Record<string, string>>();
	#time = 1;

	constructor(rng: Rng, log: string[], opts: SimOptions) {
		this.rng = rng;
		this.log = log;
		this.opts = opts;
		this.gen = new EditGen(rng, { duplicates: opts.duplicates, wide: opts.holds });
		const initial = this.gen.initialFiles();
		this.repo = Repo.init(filesToRecord(initial));
		this.plain = new Map([...initial].filter(([, lines]) => lines.length > 0));
		this.snapshots.push(new Set(this.repo.shared));
		log.push(`a0: ${JSON.stringify(filesToRecord(initial))}`);
	}

	/** One step. Returns the draft report of the accepted atom, or undefined if the step was skipped. */
	step(): DraftReport | undefined {
		const pinned = this.opts.pinned > 0 && this.snapshots.length > 1 && this.rng.chance(this.opts.pinned);
		const against = pinned ? this.rng.pick(this.snapshots) : this.repo.shared;
		const view = this.repo.view(against);
		const files = pinned ? filesFromView(view) : this.plain;
		const gen = this.gen.next(files, view);
		if (!gen) return undefined;
		const next = gen.apply(files);
		if (sameFiles(next, files)) return undefined;
		const reliance = this.opts.holds && this.rng.chance(0.25) ? this.gen.reliance(files) : undefined;
		const input: AtomInput = {
			author: `agent${this.rng.int(3)}`,
			message: gen.describe,
			time: this.#time++,
			edits: gen.edits,
			...(reliance ? { reliesOn: [reliance] } : {}),
		};
		const draft = buildAtom(view, input);
		this.log.push(
			`${draft.id}${pinned ? ` [against {${[...against].join(",")}}]` : ""}: ${gen.describe}` +
				(reliance ? ` reliesOn ${reliance.file}[${reliance.start},${reliance.end})` : ""),
		);
		const report = checkDraft(this.repo.graph, this.repo.shared, draft);
		this.viewOf.set(draft.id, new Set(against));
		this.expected.set(draft.id, filesToRecord(next));
		this.repo.graph.add(draft);
		this.repo.shared.add(draft.id);
		this.snapshots.push(new Set(this.repo.shared));
		if (pinned) this.plainIsTruth = false;
		this.plain = pinned ? filesFromView(this.repo.view()) : next;
		return report;
	}
}

describe("property: ground truth", () => {
	it("edits applied one after another to the projection match plain-text editing", () => {
		forCases("ground truth", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: rng.chance(0.5), pinned: 0 });
			const steps = rng.range(5, 30);
			for (let s = 0; s < steps; s++) {
				sim.step();
				assert.deepEqual(sim.repo.files(), filesToRecord(sim.plain));
			}
		});
	});
});

describe("property: no false conflicts", () => {
	it("atoms written against the full current projection without explicit holds never conflict", () => {
		forCases("no false conflicts", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: false, pinned: 0 });
			const steps = rng.range(5, 30);
			for (let s = 0; s < steps; s++) {
				const report = sim.step();
				if (report) assert.deepEqual(report.conflicts, [], "the live check reported a conflict");
				assert.deepEqual(conflicts(sim.repo.graph, sim.repo.shared), []);
			}
		});
	});
});

describe("property: order independence", () => {
	it("projecting the same set from shuffled atom lists gives identical files and sequences", () => {
		forCases("order independence", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: rng.chance(0.5), pinned: 0.35 });
			const steps = rng.range(5, 25);
			for (let s = 0; s < steps; s++) sim.step();
			const graph = sim.repo.graph;
			const reference = new View(graph, sim.repo.shared);
			const sequences = (v: View) =>
				v.knownPaths().map((p) => [p, v.sequence(p).map((l) => `${l.id}${l.visible ? "" : "-"}`)]);
			for (let k = 0; k < 3; k++) {
				const shuffled = new View(graph, rng.shuffle([...sim.repo.shared]));
				assert.deepEqual(shuffled.files(), reference.files());
				assert.deepEqual(sequences(shuffled), sequences(reference));
			}
			// A graph reloaded from JSON projects the same.
			const reloaded = Graph.fromJSON(JSON.parse(JSON.stringify(graph)));
			assert.deepEqual(new View(reloaded, rng.shuffle([...sim.repo.shared])).files(), reference.files());
		});
	});
});

describe("property: subset consistency", () => {
	it("an atom's closure keeps the full set's line order and every visible line it wrote", () => {
		forCases("subset consistency", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: rng.chance(0.5), pinned: 0.35 });
			const steps = rng.range(5, 25);
			for (let s = 0; s < steps; s++) sim.step();
			const graph = sim.repo.graph;
			const full = new View(graph, sim.repo.shared);
			const atoms = rng.shuffle([...sim.repo.shared]).slice(0, 10);
			for (const atom of atoms) {
				const inside = graph.closure(atom);
				const sub = new View(graph, inside);
				for (const path of full.knownPaths()) {
					const fullSeq = full.sequence(path).map((l) => l.id);
					// The closure's sequence is the full sequence restricted to lines written inside the closure.
					assert.deepEqual(
						sub.sequence(path).map((l) => l.id),
						fullSeq.filter((id) => inside.has(writerOf(id))),
						`sequence of ${path} under closure(${atom})`,
					);
					// The spec's two conditions, stated directly on visible lines.
					const subVisible = sub.lines(path).map((l) => l.id);
					const subSet = new Set(subVisible);
					const fullVisible = full.lines(path).map((l) => l.id);
					for (const id of fullVisible) {
						if (inside.has(writerOf(id)))
							assert.ok(subSet.has(id), `${id} is visible in the full set but missing under closure(${atom})`);
					}
					const fullSet = new Set(fullVisible);
					assert.deepEqual(
						fullVisible.filter((id) => subSet.has(id)),
						subVisible.filter((id) => fullSet.has(id)),
						`relative order of ${path} under closure(${atom})`,
					);
				}
			}
		});
	});
});

describe("property: placement", () => {
	it("each atom, added to the set it was written against, is exactly its plain-text edit, and in its closure each run sits right after its parent", () => {
		forCases("placement", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: rng.chance(0.5), pinned: 0.35 });
			const steps = rng.range(5, 25);
			for (let s = 0; s < steps; s++) sim.step();
			const graph = sim.repo.graph;
			for (const [id, against] of sim.viewOf) {
				const atom = graph.atom(id);
				const result = new View(graph, [...against, id]);
				assert.deepEqual(result.files(), sim.expected.get(id), `${id} against {${[...against].join(",")}}`);
				// The run outranks every other line hanging off its parent there, so it
				// comes right after the parent (the first run per parent, when an atom
				// inserts twice after one line).
				for (const view of [result, new View(graph, graph.closure(id))]) {
					const seenParents = new Set<string>();
					let k = 0;
					for (const run of atom.inserts) {
						const first = `${id}.${k}`;
						k += run.lines.length;
						if (seenParents.has(run.parent)) continue;
						seenParents.add(run.parent);
						const parentAt = isStartNode(run.parent) ? -1 : view.sequenceIndex(run.file, run.parent);
						assert.equal(view.sequenceIndex(run.file, first), parentAt + 1, `${first} right after ${run.parent}`);
					}
				}
			}
		});
	});
});

describe("property: live holds", () => {
	it("written against the full projection, the collisions are exactly the edits into holds of atoms they do not name", () => {
		let reported = 0;
		forCases("live holds", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: true, pinned: 0 });
			const steps = rng.range(5, 30);
			for (let s = 0; s < steps; s++) {
				const report = sim.step();
				if (!report) continue;
				const graph = sim.repo.graph;
				const draft = graph.atoms()[graph.size - 1]!;
				// Every earlier holder of a key the draft writes, and only those.
				const expected = new Map<AtomId, string[]>();
				for (const key of draft.writes) {
					for (const holder of graph.holdersOf(key)) {
						if (holder === draft.id || draft.needs.includes(holder)) continue;
						expected.set(holder, [...(expected.get(holder) ?? []), key]);
					}
				}
				assert.deepEqual(
					report.conflicts.map((c) => [c.atoms[0], c.keys.map((k) => k.key)]),
					[...expected]
						.sort((p, q) => graph.atom(p[0]).seq - graph.atom(q[0]).seq)
						.map(([h, keys]) => [h, keys.sort()]),
					`holds written by ${draft.id}`,
				);
				reported += report.conflicts.length;
				for (const c of report.conflicts) {
					assert.equal(c.kind, "semantic");
					for (const key of c.keys) {
						assert.equal(key.writer, c.atoms[1], `${key.key}: the draft must be the writer`);
						assert.equal(key.relation, "hold");
					}
				}
			}
			for (const c of conflicts(sim.repo.graph, sim.repo.shared)) {
				assert.equal(c.kind, "semantic", `${c.atoms.join(" vs ")}`);
				for (const key of c.keys) {
					assert.equal(
						key.writer,
						c.atoms[1],
						`${c.atoms.join(" vs ")} on ${key.key}: the later atom must be the writer`,
					);
					assert.equal(key.relation, "hold");
				}
			}
		});
		if (CASES >= 100) assert.ok(reported > CASES / 4, `only ${reported} live collisions were checked`);
	});
});

// Conflicted sets are the normal state after plain-git ingest or pinned
// views, and agents keep editing live on top of them.
describe("property: live edits on a conflicted set", () => {
	it("still match plain-text editing of the projection and never collide", () => {
		let onConflicted = 0;
		forCases("live on conflicted", (rng, log) => {
			const gen = new EditGen(rng, { duplicates: rng.chance(0.5), wide: false });
			const initial = gen.initialFiles();
			const repo = Repo.init(filesToRecord(initial));
			log.push(`a0: ${JSON.stringify(filesToRecord(initial))}`);
			const snapshots: Set<AtomId>[] = [new Set(repo.shared)];
			const steps = rng.range(8, 30);
			for (let s = 0; s < steps; s++) {
				const pinned = snapshots.length > 1 && rng.chance(0.35);
				const against = pinned ? rng.pick(snapshots) : repo.shared;
				const view = repo.view(against);
				const files = filesFromView(view);
				const g = gen.next(files, view);
				if (!g) continue;
				const next = g.apply(files);
				if (sameFiles(next, files)) continue;
				const draft = buildAtom(view, { author: `agent${rng.int(3)}`, message: g.describe, edits: g.edits });
				log.push(`${draft.id}${pinned ? ` [against {${[...against].join(",")}}]` : ""}: ${g.describe}`);
				if (!pinned) {
					if (unresolvedConflicts(repo.graph, repo.shared).length > 0) onConflicted++;
					assert.deepEqual(checkDraft(repo.graph, repo.shared, draft).conflicts, [], "a live edit collided");
				}
				repo.graph.add(draft);
				repo.shared.add(draft.id);
				snapshots.push(new Set(repo.shared));
				if (!pinned) {
					assert.deepEqual(repo.files(), filesToRecord(next), "live edit on top of the shared projection");
					assert.ok(
						!conflicts(repo.graph, repo.shared).some((c) => c.atoms.includes(draft.id)),
						"the live atom is in a conflict",
					);
				}
			}
		});
		if (CASES >= 100) assert.ok(onConflicted > CASES / 2, `only ${onConflicted} live edits ran on a conflicted set`);
	});
});

// The CLI rejects a draft from checkDraft's report, while `conflicts` reads
// the stored set. They must agree, holds and pinned views included.
describe("property: the live check agrees with the set", () => {
	it("checkDraft reports exactly the conflicts that accepting the draft adds", () => {
		let reportedTotal = 0;
		forCases("checkDraft vs conflicts", (rng, log) => {
			const sim = new Sim(rng, log, { duplicates: rng.chance(0.5), holds: true, pinned: 0.35 });
			const steps = rng.range(5, 25);
			for (let s = 0; s < steps; s++) {
				const report = sim.step();
				if (!report) continue;
				const graph = sim.repo.graph;
				const id = graph.atoms()[graph.size - 1]!.id;
				const shape = (c: Conflict) => ({ atoms: c.atoms, kind: c.kind, keys: c.keys, sides: c.sides });
				const added = conflicts(graph, sim.repo.shared).filter((c) => c.atoms.includes(id));
				assert.deepEqual(report.conflicts.map(shape), added.map(shape), `conflicts of ${id}`);
				reportedTotal += added.length;
			}
		});
		if (CASES >= 100) assert.ok(reportedTotal > CASES / 4, `only ${reportedTotal} conflicts were checked`);
	});
});
