import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../graph.ts";
import { withProjectionScratch } from "../projection-scratch.ts";
import { resolveScratchMoves } from "../relocation-scratch.ts";
import { CachedStateStorage, StableOverlaySet } from "../state-source.ts";
import { View } from "../view.ts";
import { Repo, Rng } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("scratch relocation cycle selection matches View across differing memberships and tied moves", () => {
	const rng = new Rng(45131);
	const source = new SqlState();
	const storage = new CachedStateStorage(source, 4096, 16);
	try {
		for (let trial = 0; trial < 24; trial++) {
			const repo = Repo.init({ "f.txt": Array.from({ length: 24 }, (_, n) => `line ${n}\n`).join(""), "g.txt": "" });
			const earlier = new Set(repo.shared);
			for (let j = 0; j < 32; j++) {
				const offset = rng.int(24);
				const moves = Array.from({ length: 3 }, (_, index) => {
					const line = `a0.${(offset + index) % 24}`;
					const candidate = `a0.${rng.int(24)}`;
					return { line, parent: candidate === line ? (j % 2 ? "^f.txt" : "^g.txt") : candidate };
				});
				const id = repo.graph.nextId();
				repo.graph.add({
					id,
					seq: repo.graph.size,
					author: "fixture",
					message: "move",
					time: j,
					inserts: [],
					deletes: [],
					writes: moves.flatMap((move) => [`P:${move.line}`, `G:${move.parent}`]),
					reads: [],
					holds: [],
					needs: [],
					resolves: [],
					reasons: [],
					deps: ["a0"],
					moves,
				});
				repo.shared.add(id);
				if (j < 16) earlier.add(id);
			}
			for (const membership of [repo.shared, earlier, repo.shared]) {
				const oracle = new View(repo.graph, membership);
				const parents = withProjectionScratch(
					storage,
					() => {},
					(scratch) => {
						const resolved = resolveScratchMoves(repo.graph, (id) => membership.has(id), scratch);
						return Array.from({ length: 24 }, (_, n) => resolved.parent(`a0.${n}`));
					},
				);
				assert.deepEqual(
					parents,
					Array.from({ length: 24 }, (_, n) => oracle.parentOf(`a0.${n}`)),
				);
				assert.equal(source.db.prepare("SELECT count(*) AS n FROM state").get()!.n, 0);
				assert.equal(storage.retainedEntries, 0);
			}
			if (trial < 4) {
				const persisted = new SqlState();
				try {
					const indexed = new Graph({ storage: new CachedStateStorage(persisted, 8192, 32) });
					for (const id of repo.shared) indexed.add(repo.graph.atom(id));
					const before = persisted.db.prepare("SELECT * FROM state ORDER BY collection, key").all();
					// Restart before projecting, then alternate membership on the same graph.
					const reopened = new Graph({ storage: new CachedStateStorage(persisted, 8192, 32) });
					for (const membership of [repo.shared, earlier, repo.shared]) {
						const expected = new View(repo.graph, membership);
						const actual = new View(reopened, new StableOverlaySet(membership));
						for (const path of ["f.txt", "g.txt"]) {
							assert.equal(actual.text(path), expected.text(path));
							assert.deepEqual(actual.sequence(path), expected.sequence(path));
						}
						for (const n of [0, 11, 23]) {
							assert.equal(actual.parentOf(`a0.${n}`), expected.parentOf(`a0.${n}`));
							assert.equal(actual.fileOf(`a0.${n}`), expected.fileOf(`a0.${n}`));
						}
						assert.deepEqual(persisted.db.prepare("SELECT * FROM state ORDER BY collection, key").all(), before);
					}
				} finally {
					persisted.db.close();
				}
			}
		}
	} finally {
		source.db.close();
	}
});

test("scratch relocation write failure rolls back without changing canonical graph state", () => {
	const repo = Repo.init({ f: "one\ntwo\n" });
	const source = new SqlState();
	try {
		repo.graph.add({
			id: "a1",
			seq: 1,
			author: "fixture",
			message: "move",
			time: 1,
			inserts: [],
			deletes: [],
			writes: ["P:a0.0", "G:a0.1"],
			reads: [],
			holds: [],
			needs: [],
			resolves: [],
			reasons: [],
			deps: ["a0"],
			moves: [{ line: "a0.0", parent: "a0.1" }],
		});
		repo.shared.add("a1");
		const before = { size: repo.graph.size, lines: repo.graph.lineCount };
		source.failWrite = 3;
		assert.throws(
			() =>
				withProjectionScratch(
					source,
					() => {},
					(scratch) => {
						resolveScratchMoves(repo.graph, (id) => repo.shared.has(id), scratch);
					},
				),
			/injected storage failure/,
		);
		assert.deepEqual({ size: repo.graph.size, lines: repo.graph.lineCount }, before);
		assert.equal(source.db.prepare("SELECT count(*) AS n FROM state").get()!.n, 0);
	} finally {
		source.db.close();
	}
});
