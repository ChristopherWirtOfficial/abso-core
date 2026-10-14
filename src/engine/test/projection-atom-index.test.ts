import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectionAtomAdoption } from "../experimental/projection-atom-adoption.ts";
import { indexAcceptedProjectionAtom, ProjectionAtomIndex } from "../experimental/projection-atom-index.ts";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { Graph } from "../graph.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("accepted atom indexing preserves the original digest without serializing the whole atom", (t) => {
	const db = new SqlState();
	t.after(() => db.db.close());
	const repo = Repo.init({ "a.txt": `${"x".repeat(16383)}\ud83d\ude80\n${"\u0000".repeat(20000)}\n` });
	const atom = repo.graph.atom("a0");
	const expected = createHash("sha256").update(JSON.stringify(atom)).digest("hex");
	const stringify = JSON.stringify;
	t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
		assert.notEqual(args[0], atom, "indexing must not rematerialize the full atom JSON");
		return stringify(...args);
	});
	indexAcceptedProjectionAtom(atom, ["a.txt"], db);
	assert.equal(new ProjectionAtomIndex(db).openAccepted("a0").digest, expected);
});

test("projection atom descriptors exclude inserted text and read one indexed item", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "large text\n".repeat(1000) });
		const atom = repo.graph.atom("a0"),
			digest = "a".repeat(64);
		new ProjectionAtomIndex(db).put(atom, digest, ["a.txt"]);
		const descriptor = new ProjectionAtomIndex(db).open("a0", digest);
		const before = db.reads;
		assert.equal(descriptor.count("inserts"), 1);
		assert.deepEqual(descriptor.item("inserts", 0), { file: "a.txt", parent: "^a.txt", lines: 1000 });
		assert.equal(db.reads - before, 1);
		assert.throws(() => descriptor.item("inserts", 1), /out of range/);
		assert.throws(() => new ProjectionAtomIndex(db).open("a0", "b".repeat(64)), /invalid/);
		const rows = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		assert.ok(!JSON.stringify(rows).includes("large text"));
		assert.throws(() => new ProjectionAtomIndex(db).put(atom, digest, ["a.txt"]), /already exists/);
		assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), rows);
	} finally {
		db.db.close();
	}
});

test("descriptor builds roll back every write and corrupted records refuse", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\n" });
		const atom = repo.graph.atom("a0"),
			digest = "c".repeat(64);
		const index = new ProjectionAtomIndex(db);
		const writeCount =
			atom.deps.length +
			atom.inserts.length +
			atom.deletes.length +
			(atom.attrs?.length ?? 0) +
			(atom.moves?.length ?? 0) +
			2;
		for (let offset = 1; offset <= writeCount; offset++) {
			db.failWrite = db.writes + offset;
			assert.throws(() => index.put(atom, digest, ["a.txt"]), /injected/);
			assert.deepEqual(db.db.prepare("SELECT * FROM state").all(), []);
		}
		db.failWrite = Infinity;
		index.put(atom, digest, ["a.txt"]);
		const name = "projection-atom-index:a0";
		const header = db.read(name, "header") as { counts: Record<string, number> };
		for (const invalid of [
			null,
			{ ...header, extra: true },
			{ ...header, counts: { ...header.counts, moves: -1 } },
			{ ...header, counts: [] },
			{ ...header, counts: { ...header.counts, inserts: 0 } },
		]) {
			db.write(name, "header", invalid);
			assert.throws(() => new ProjectionAtomIndex(db).open("a0", digest), /invalid/);
		}
		db.write(name, "header", header);
		const descriptor = new ProjectionAtomIndex(db).open("a0", digest);
		const original = db.read(name, "inserts:0") as { value: unknown; checksum: string };
		for (const invalid of [
			null,
			{ file: "a.txt", parent: "bad", lines: 1 },
			{ file: "a.txt", parent: "^a.txt", lines: -1 },
			{ file: "a.txt", parent: "^a.txt", lines: 1, extra: true },
			{ ...original, value: { file: "a.txt", parent: "^a.txt", lines: 2 } },
		]) {
			db.write(name, "inserts:0", invalid);
			assert.throws(() => descriptor.item("inserts", 0), /invalid/);
		}
		db.write(name, "inserts:0", original);
		const run = descriptor.item("inserts", 0);
		run.lines = 999;
		assert.equal(descriptor.item("inserts", 0).lines, 1);
	} finally {
		db.db.close();
	}
});

test("descriptor-driven insertion adoption never reads full atom storage", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\nthree\n" });
		const atom = repo.graph.atom("a0"),
			digest = "d".repeat(64);
		const graph = new Graph({ storage: db });
		graph.add(atom);
		new ProjectionAtomIndex(db).put(atom, digest, graph.filesOf(atom.id));
		const projection = new ExperimentalMarkerProjection(db, graph, "a.txt", "indexed-adoption");
		const previous = projection.empty();
		const read = db.read.bind(db);
		db.read = (collection, key) => {
			if (collection === "atoms") throw Error("full atom read forbidden");
			return read(collection, key);
		};
		let pages = 0;
		for (;;) {
			const descriptor = new ProjectionAtomIndex(db).open(atom.id, digest);
			const result = new ProjectionAtomAdoption(projection, "indexed").page({
				previous,
				atom: descriptor,
				remove: false,
				source: "e".repeat(64),
				maxSteps: 2,
				validateSource: () => {},
			});
			assert.ok(result.steps <= 2);
			assert.ok(++pages < 100);
			if (result.done) {
				assert.deepEqual(projection.lines(result.state), ["a0.0", "a0.1", "a0.2"]);
				break;
			}
		}
		assert.ok(pages > 1);
	} finally {
		db.db.close();
	}
});

test("indexed adoption reopens through dependencies, attributes, deletion and reverse removal without atom reads", () => {
	const directory = mkdtempSync(join(tmpdir(), "abso-descriptor-")),
		filename = join(directory, "state.sqlite");
	let db = new SqlState(filename);
	const oracleDb = new SqlState();
	try {
		const repo = Repo.init({ "a.txt": "one\ntwo\nthree\n", "b.txt": "" });
		const atoms = [
			repo.graph.atom("a0"),
			repo.edit({
				edits: [{ file: "a.txt", old: "two\n", new: "replacement\n" }],
				attrs: [{ file: "b.txt", name: "exec", value: "1" }],
			}),
		];
		atoms.push(repo.edit({ move: { file: "a.txt", start: 0, end: 1, to: "b.txt", at: 0 } }));
		const graph = new Graph({ storage: db });
		for (const atom of atoms) {
			graph.add(atom);
			new ProjectionAtomIndex(db).put(atom, "a".repeat(64), graph.filesOf(atom.id));
		}
		const oracle = new ExperimentalMarkerProjection(oracleDb, repo.graph, "a.txt", "oracle");
		let expected = oracle.empty();
		let state = new ExperimentalMarkerProjection(db, graph, "a.txt", "indexed").empty();
		let task = 0;
		for (const [atom, remove] of [
			...atoms.map((atom) => [atom, false] as const),
			...atoms.toReversed().map((atom) => [atom, true] as const),
		]) {
			const previous = state,
				id = String(task++);
			let pages = 0,
				done = false;
			while (!done) {
				const read = db.read.bind(db);
				db.read = (collection, key) => {
					if (collection === "atoms") throw Error("full atom read forbidden");
					return read(collection, key);
				};
				const p = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "indexed");
				const descriptor = new ProjectionAtomIndex(db).open(atom.id, "a".repeat(64));
				const result = new ProjectionAtomAdoption(p, id).page({
					previous,
					atom: descriptor,
					remove,
					source: "b".repeat(64),
					maxSteps: 2,
					validateSource: () => {},
				});
				state = result.state;
				done = result.done;
				assert.ok(++pages < 100);
				db.db.close();
				db = new SqlState(filename);
			}
			expected = remove ? oracle.removeAtom(expected, atom) : oracle.apply(expected, atom);
			const actual = new ExperimentalMarkerProjection(db, new Graph({ storage: db }), "a.txt", "indexed");
			for (const path of ["a.txt", "b.txt"]) {
				assert.deepEqual(actual.lines(state, path), oracle.lines(expected, path));
				assert.deepEqual(actual.attrs(state, path), oracle.attrs(expected, path));
			}
			assert.deepEqual(actual.knownPaths(state), oracle.knownPaths(expected));
		}
	} finally {
		db.db.close();
		oracleDb.db.close();
		unlinkSync(filename);
		rmdirSync(directory);
	}
});

test("accepted graph and descriptor commit together and retry after callback failure", () => {
	const db = new SqlState();
	try {
		const atom = Repo.init({ "a.txt": "one\n" }).graph.atom("a0");
		let fail = true;
		const graph = new Graph({
			storage: db,
			indexAcceptedAtom: (accepted, files, storage) => {
				indexAcceptedProjectionAtom(accepted, files, storage);
				if (fail) throw Error("after descriptor failure");
			},
		});
		const before = db.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
		assert.throws(() => graph.add(atom), /after descriptor failure/);
		assert.deepEqual(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		assert.equal(graph.size, 0);
		fail = false;
		graph.add(atom);
		const digest = createHash("sha256").update(JSON.stringify(atom)).digest("hex");
		assert.equal(new ProjectionAtomIndex(db).open("a0", digest).item("inserts", 0).lines, 1);
		assert.equal(new Graph({ storage: db }).size, 1);
		assert.throws(() => new Graph({ indexAcceptedAtom: indexAcceptedProjectionAtom }), /requires persistent/);
	} finally {
		db.db.close();
	}
});
