import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resolveMovesPage } from "../experimental/projection-move-resolution.ts";
import type { RelocationInfo } from "../graph.ts";
import { resolveScratchMoves } from "../relocation-scratch.ts";
import { Repo, Rng } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("one-step move pages preserve cycle resolution across competing and excluded moves", () => {
	const rng = new Rng(45131);
	let resolvedCycles = 0;
	for (let trial = 0; trial < 8; trial++) {
		const repo = Repo.init({ "f.txt": Array.from({ length: 12 }, (_, i) => `${i}\n`).join(""), "g.txt": "" });
		for (let j = 0; j < 12; j++) {
			const offset = rng.int(12);
			const moves = Array.from({ length: 3 }, (_, k) => {
				const line = `a0.${(offset + k) % 12}`,
					parent = `a0.${rng.int(12)}`;
				return { line, parent: parent === line ? "^g.txt" : parent };
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
				writes: moves.flatMap((m) => [`P:${m.line}`, `G:${m.parent}`]),
				reads: [],
				holds: [],
				needs: [],
				resolves: [],
				reasons: [],
				deps: ["a0"],
				moves,
			});
			if ((j + trial) % 3) repo.shared.add(id);
		}
		const expected = new SqlState(),
			actual = new SqlState();
		try {
			const oracle = resolveScratchMoves(repo.graph, (id) => repo.shared.has(id), expected);
			let done = false,
				pages = 0;
			while (!done) {
				const before = actual.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
				actual.failWrite = actual.writes + 1;
				assert.throws(
					() => resolveMovesPage(repo.graph, (id) => repo.shared.has(id), actual, `trial-${trial}`, 1),
					/injected storage failure/,
				);
				assert.deepEqual(actual.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
				actual.failWrite = Infinity;
				const result = resolveMovesPage(repo.graph, (id) => repo.shared.has(id), actual, `trial-${trial}`, 1);
				assert.ok(result.steps <= 1);
				done = result.done;
				assert.ok(++pages < 10000);
			}
			for (let n = 0; n < 12; n++) {
				const line = `a0.${n}`,
					selected = actual.read("selected", line) as RelocationInfo | undefined;
				assert.deepEqual(selected, oracle.selected(line));
				assert.equal(selected?.parent ?? repo.graph.lineParent(line), oracle.parent(line));
			}
			resolvedCycles += [...actual.entries("ignored")].length;
			const rows = actual.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
			assert.throws(() => resolveMovesPage(repo.graph, () => true, actual, "changed", 1), /identity changed/);
			assert.deepEqual(actual.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), rows);
		} finally {
			expected.db.close();
			actual.db.close();
		}
	}
	assert.ok(resolvedCycles > 0, "the fixture must exercise cycle breaking");
});

test("damaged and structurally invalid move cursors refuse without changing stored state", () => {
	const repo = Repo.init({ "f.txt": "a\nb\n" });
	const storage = new SqlState();
	try {
		resolveMovesPage(repo.graph, () => true, storage, "source", 1);
		const valid = storage.read("progress", "cursor") as {
			format: number;
			checksum: string;
			state: Record<string, unknown>;
		};
		const changes: Array<(record: typeof valid) => void> = [
			(record) => {
				record.checksum = "damaged";
			},
			(record) => {
				record.format = 2;
			},
			(record) => {
				record.state.phase = "unknown";
			},
			(record) => {
				record.state.mover = 1;
			},
			(record) => {
				record.state.move = 1;
			},
			(record) => {
				record.state.item = 1;
			},
			(record) => {
				record.state.work = repo.graph.lineCount + 1;
			},
			(record) => {
				record.state.slow = 4;
			},
			(record) => {
				record.state.phase = "repick";
			},
			(record) => {
				record.state.extra = true;
			},
		];
		for (const [index, change] of changes.entries()) {
			const damaged = structuredClone(valid);
			change(damaged);
			if (index > 0) damaged.checksum = createHash("sha256").update(JSON.stringify(damaged.state)).digest("hex");
			storage.write("progress", "cursor", damaged);
			const before = storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all();
			assert.throws(() => resolveMovesPage(repo.graph, () => true, storage, "source", 1), /invalid|damaged|incomplete/);
			assert.deepEqual(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all(), before);
		}
		storage.write("progress", "cursor", valid);
		assert.equal(resolveMovesPage(repo.graph, () => true, storage, "source", 1).done, true);
	} finally {
		storage.db.close();
	}
});
