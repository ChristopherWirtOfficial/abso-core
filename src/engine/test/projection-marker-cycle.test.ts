import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionAtomAdoption } from "../experimental/projection-atom-adoption.ts";
import { indexAcceptedProjectionAtom, ProjectionAtomIndex } from "../experimental/projection-atom-index.ts";
import { ExperimentalMarkerProjection as MarkerProjection } from "../experimental/projection-marker.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import type { Atom } from "../types.ts";
import { Repo, Rng } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

for (const paged of [false, true, "indexed"] as const)
	test(`typed marker projection matches competing cyclic moves and removals (paged=${paged})`, () => {
		const db = new SqlState();
		try {
			const repo = Repo.init({ "f.txt": Array.from({ length: 12 }, (_, n) => `${n}\n`).join("") }),
				graph = new Graph({
					storage: new CachedStateStorage(db),
					indexAcceptedAtom: paged === "indexed" ? indexAcceptedProjectionAtom : undefined,
				}),
				rng = new Rng(45131);
			graph.add(repo.graph.atom("a0"));
			const p = new MarkerProjection(db, graph, "f.txt", "typed-" + "cycle");
			let state = p.apply(p.empty(), repo.graph.atom("a0")),
				checks = 0;
			const atoms = [];
			let task = 0;
			const apply = (atom: Atom, remove: boolean) => {
				if (!paged) return remove ? p.removeAtom(state, atom) : p.apply(state, atom);
				const job = new ProjectionAtomAdoption(p, String(task++));
				const previous = state;
				for (let pages = 0; pages < 10000; pages++) {
					const read = db.read.bind(db);
					if (paged === "indexed")
						db.read = (collection, key) => {
							if (collection === "atoms") throw Error("full atom read forbidden");
							return read(collection, key);
						};
					let result;
					try {
						result = job.page({
							previous,
							atom: paged === "indexed" ? new ProjectionAtomIndex(db).openAccepted(atom.id) : atom,
							remove,
							source: "c".repeat(64),
							maxSteps: 3,
							validateSource: () => {},
						});
					} finally {
						db.read = read;
					}
					assert.ok(result.steps <= 3);
					assert.equal(result.atomicMoveWork, false);
					if (result.done) return result.state;
				}
				throw Error("move adoption did not finish");
			};
			const check = () => {
				const view = repo.view();
				assert.deepEqual(
					p.lines(state),
					view.lines("f.txt").map((x) => x.id),
				);
				for (let n = 0; n < 12; n++) {
					const parent = view.parentOf(`a0.${n}`);
					assert.equal(
						(p.markers.get(state.locator, n + 1) as { parentKey: number }).parentKey,
						parent.startsWith("^") ? 0 : graph.lineN(parent) + 1,
					);
				}
				checks++;
			};
			for (let j = 0; j < 24; j++) {
				const offset = rng.int(12),
					moves = Array.from({ length: 3 }, (_, i) => {
						const line = `a0.${(offset + i) % 12}`,
							candidate = `a0.${rng.int(12)}`;
						return { line, parent: candidate === line ? "^f.txt" : candidate };
					});
				const atom = {
					id: repo.graph.nextId(),
					seq: repo.graph.size,
					author: "fixture",
					message: "move",
					time: j,
					inserts: [],
					deletes: [],
					writes: moves.flatMap((m) => [`P:${m.line}`, `G:${m.parent}`]),
					reads: [],
					holds: [],
					needs: [],
					resolves: [],
					reasons: [],
					deps: ["a0"],
					moves,
				};
				repo.graph.add(atom);
				repo.shared.add(atom.id);
				graph.add(atom);
				atoms.push(atom);
				state = apply(atom, false);
				check();
			}
			for (const atom of atoms.filter((_, i) => i % 2 === 0)) {
				repo.shared.delete(atom.id);
				state = apply(atom, true);
				check();
			}
			assert.equal(
				db.db
					.prepare(
						"SELECT count(*) AS n FROM state WHERE collection LIKE '%sequence-resolver:%' OR collection LIKE '%sequence-relocation-work:%' OR collection LIKE '%move-adoption:%'",
					)
					.get()!.n,
				0,
			);
			assert.equal(checks, 36);
		} finally {
			db.db.close();
		}
	});
