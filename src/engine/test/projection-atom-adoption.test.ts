import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectionAtomAdoption } from "../experimental/projection-atom-adoption.ts";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { adoptMovesStep } from "../experimental/projection-move-adoption.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("an unfinished atom resumes after closing and reopening its SQLite database", () => {
	const directory = mkdtempSync(join(tmpdir(), "abso-atom-adoption-"));
	const filename = join(directory, "state.sqlite");
	let db = new SqlState(filename);
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\nthree\nfour\n" });
		const atom = repo.graph.atom("a0");
		new Graph({ storage: db }).add(atom);
		const previous = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "restart").empty();
		let done = false,
			pages = 0;
		while (!done) {
			const adapter = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "restart");
			const result = new ProjectionAtomAdoption(adapter, "initial").page({
				previous,
				atom,
				remove: false,
				source: "d".repeat(64),
				maxSteps: 2,
				validateSource: () => {},
			});
			assert.ok(result.steps <= 2);
			done = result.done;
			if (done)
				assert.deepEqual(
					adapter.lines(result.state),
					repo
						.view()
						.lines("a.txt")
						.map((line) => line.id),
				);
			assert.ok(++pages < 50);
			db.db.close();
			db = new SqlState(filename);
		}
		assert.ok(pages > 5);
	} finally {
		db.db.close();
		unlinkSync(filename);
		rmdirSync(directory);
	}
});

test("atom adoption resumes small pages and matches atomic additions and reverse removals", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({
			"a.txt": Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""),
			"b.txt": "other\n",
		});
		const graph = new Graph({ storage: new CachedStateStorage(db) });
		const atoms = [repo.graph.atom("a0")];
		atoms.push(
			repo.edit({
				edits: [{ file: "a.txt", old: repo.view().text("a.txt"), new: "replacement\n" }],
				attrs: [{ file: "b.txt", name: "exec", value: "1" }],
			}),
		);
		atoms.push(repo.edit({ move: { file: "a.txt", start: 0, end: 1, to: "b.txt", at: 0 } }));
		for (const atom of atoms) graph.add(atom);
		const adapter = () => new ExperimentalMarkerProjection(db, graph, "a.txt", "paged");
		const oracle = new ExperimentalMarkerProjection(db, graph, "a.txt", "atomic");
		let state = adapter().empty(),
			expected = oracle.empty(),
			task = 0;
		for (const [atom, remove] of [
			...atoms.map((a) => [a, false] as const),
			...atoms.toReversed().map((a) => [a, true] as const),
		]) {
			const previous = state,
				id = String(task++);
			let done = false,
				pages = 0,
				atomicMovePages = 0;
			while (!done) {
				const result = new ProjectionAtomAdoption(adapter(), id).page({
					previous,
					atom,
					remove,
					source: "a".repeat(64),
					maxSteps: 3,
					validateSource: () => {},
				});
				assert.ok(result.steps <= 3);
				if (result.atomicMoveWork) atomicMovePages++;
				state = result.state;
				done = result.done;
				assert.ok(++pages < 200);
			}
			assert.ok(pages > 1);
			assert.equal(atomicMovePages, 0);
			assert.equal(
				db.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection LIKE ?").get("%move-adoption:%")!.n,
				0,
			);
			expected = remove ? oracle.removeAtom(expected, atom) : oracle.apply(expected, atom);
			for (const path of ["a.txt", "b.txt"]) {
				assert.deepEqual(adapter().lines(state, path), oracle.lines(expected, path));
				assert.deepEqual(adapter().attrs(state, path), oracle.attrs(expected, path));
			}
			assert.deepEqual(adapter().knownPaths(state), oracle.knownPaths(expected));
		}
	} finally {
		db.db.close();
	}
});

test("source drift rolls back an atom page and a changed atom cannot resume its cursor", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\nthree\n" });
		const graph = new Graph({ storage: db });
		const atom = repo.graph.atom("a0");
		graph.add(atom);
		const adapter = new ExperimentalMarkerProjection(db, graph, "a.txt", "failure");
		const job = new ProjectionAtomAdoption(adapter, "one");
		const input = {
			previous: adapter.empty(),
			atom,
			remove: false,
			source: "b".repeat(64),
			maxSteps: 3,
			validateSource: () => {},
		};
		job.page(input);
		const rows = () => db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		const before = rows();
		const saved = adapter.storage.read("atom-adoption:one", "cursor") as {
			format: number;
			checksum: string;
			cursor: { index: number; run: number; phase: string; state: { sequence: { next: number } } };
		};
		for (const field of ["checksum", "index", "run", "sequence", "phase"]) {
			const damaged = structuredClone(saved);
			if (field === "checksum") damaged.checksum = "bad";
			else {
				if (field === "index") damaged.cursor.index = Number.MAX_SAFE_INTEGER;
				if (field === "run") damaged.cursor.run = atom.inserts.length + 1;
				if (field === "sequence") damaged.cursor.state.sequence.next = -1;
				if (field === "phase") damaged.cursor.phase = "unknown";
				damaged.checksum = createHash("sha256").update(JSON.stringify(damaged.cursor)).digest("hex");
			}
			adapter.storage.write("atom-adoption:one", "cursor", damaged);
			const corruptRows = rows();
			assert.throws(() => job.page(input), /invalid|damaged/, field);
			assert.deepEqual(rows(), corruptRows, field);
			adapter.storage.write("atom-adoption:one", "cursor", saved);
		}
		assert.deepEqual(rows(), before);
		assert.throws(() => job.page({ ...input, validateSource: () => Promise.resolve() }), /must be synchronous/);
		assert.deepEqual(rows(), before);
		let asyncChecks = 0;
		assert.throws(
			() => job.page({ ...input, validateSource: () => (++asyncChecks === 2 ? Promise.resolve() : undefined) }),
			/must be synchronous/,
		);
		assert.deepEqual(rows(), before);
		let checks = 0;
		assert.throws(
			() =>
				job.page({
					...input,
					validateSource: () => {
						if (++checks === 2) throw Error("source drift");
					},
				}),
			/source drift/,
		);
		assert.deepEqual(rows(), before);
		assert.throws(
			() => job.page({ ...input, atom: { ...atom, message: "changed" } }),
			/canonical adoption atom mismatch/,
		);
		assert.deepEqual(rows(), before);
		assert.throws(() => job.page({ ...input, source: "c".repeat(64) }), /changed atom adoption cursor/);
		assert.deepEqual(rows(), before);
		assert.equal(job.page(input).steps, 3);
	} finally {
		db.db.close();
	}
});

test("move adoption rolls back complete pages and resumes every phase after SQLite reopen", () => {
	const directory = mkdtempSync(join(tmpdir(), "abso-move-restart-"));
	const filename = join(directory, "state.sqlite");
	let db = new SqlState(filename);
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "other\n" });
		const initial = repo.graph.atom("a0");
		const move = repo.edit({ move: { file: "a.txt", start: 0, end: 2, to: "b.txt", at: 1 } });
		const graph = new Graph({ storage: db });
		graph.add(initial);
		graph.add(move);
		const first = new ExperimentalMarkerProjection(db, graph, "a.txt", "restart-moves");
		let state = first.apply(first.empty(), initial);
		const phases = new Set<string>();
		for (const remove of [false, true]) {
			const previous = state;
			let done = false,
				pages = 0;
			while (!done) {
				const adapter = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "restart-moves");
				const job = new ProjectionAtomAdoption(adapter, remove ? "remove" : "add");
				const input = { previous, atom: move, remove, source: "f".repeat(64), maxSteps: 1, validateSource: () => {} };
				const before = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
				let validations = 0;
				assert.throws(
					() =>
						job.page({
							...input,
							validateSource: () => {
								if (++validations === 2) throw Error("source changed after page");
							},
						}),
					/source changed after page/,
				);
				assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
				const result = job.page(input);
				state = result.state;
				done = result.done;
				assert.equal(result.atomicMoveWork, false);
				assert.ok(result.steps <= 1);
				const saved = adapter.storage.read(`move-adoption:${remove ? "remove" : "add"}`, "cursor") as
					| { cursor: { phase: string } }
					| undefined;
				if (saved) phases.add(saved.cursor.phase);
				assert.ok(++pages < 300);
				db.db.close();
				db = new SqlState(filename);
			}
			const adapter = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "restart-moves");
			const oracle = new ExperimentalMarkerProjection(
				db,
				new Graph({ storage: db }),
				"a.txt",
				remove ? "oracle-remove" : "oracle-add",
			);
			let expected = oracle.apply(oracle.empty(), initial);
			if (!remove) expected = oracle.apply(expected, move);
			for (const path of ["a.txt", "b.txt"]) assert.deepEqual(adapter.lines(state, path), oracle.lines(expected, path));
			assert.equal(
				db.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection LIKE ?").get("%move-adoption:%")!.n,
				0,
			);
		}
		for (const phase of ["files", "resolve", "plans", "park", "place", "cleanup"]) assert.ok(phases.has(phase), phase);
	} finally {
		db.db.close();
		unlinkSync(filename);
		rmdirSync(directory);
	}
});

test("move application rejects damaged cursor envelopes and invalid positions without mutation", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\n" });
		const adapter = new ExperimentalMarkerProjection(db, repo.graph, "a.txt", "corrupt-move");
		const state = adapter.apply(adapter.empty(), repo.graph.atom("a0"));
		const identity = "e".repeat(64);
		adoptMovesStep(adapter, state, "job", identity);
		const saved = adapter.storage.read("move-adoption:job", "cursor") as {
			format: number;
			checksum: string;
			cursor: Record<string, unknown>;
		};
		const changes: Array<(record: typeof saved) => void> = [
			(row) => {
				row.checksum = "bad";
			},
			(row) => {
				row.format = 2;
			},
			(row) => {
				row.cursor.phase = "unknown";
			},
			(row) => {
				row.cursor.identity = "another";
			},
			(row) => {
				row.cursor.mover = 1;
			},
			(row) => {
				row.cursor.move = 1;
			},
			(row) => {
				row.cursor.count = repo.graph.lineCount + 1;
			},
			(row) => {
				row.cursor.item = 1;
			},
			(row) => {
				row.cursor.collection = 9;
			},
			(row) => {
				row.cursor.extra = true;
			},
		];
		for (const [index, change] of changes.entries()) {
			const bad = structuredClone(saved);
			change(bad);
			if (index > 0) bad.checksum = createHash("sha256").update(JSON.stringify(bad.cursor)).digest("hex");
			adapter.storage.write("move-adoption:job", "cursor", bad);
			const before = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
			assert.throws(() => adoptMovesStep(adapter, state, "job", identity), /invalid|damaged/);
			assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		}
		adapter.storage.write("move-adoption:job", "cursor", saved);
		assert.equal(adoptMovesStep(adapter, state, "job", identity).done, false);
	} finally {
		db.db.close();
	}
});
