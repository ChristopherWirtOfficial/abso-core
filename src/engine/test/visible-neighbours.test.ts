import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../graph.ts";
import { CachedStateStorage, StableOverlaySet } from "../state-source.ts";
import { View } from "../view.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("visible neighbours match historical sequence without retaining it, including moves and tombstones", (t) => {
	const source = new SqlState();
	try {
		const original = Array.from({ length: 256 }, (_, n) => `line ${n}\n`).join("");
		const repo = Repo.init({ "a.txt": original, "b.txt": "other\n" });
		const sets = [new Set(repo.shared)];
		const deletion = repo.draft({ edits: [{ file: "a.txt", old: original, new: "line 0\nline 255\n" }] });
		repo.graph.add(deletion);
		repo.shared.add(deletion.id);
		sets.push(new Set(repo.shared));
		const move = repo.draft({ move: { file: "a.txt", start: 0, end: 1, to: "b.txt", at: 0 } });
		repo.graph.add(move);
		repo.shared.add(move.id);
		sets.push(new Set(repo.shared));
		const graph = new Graph({ storage: new CachedStateStorage(source) });
		for (const id of repo.shared) graph.add(repo.graph.atom(id));
		const rows = source.db.prepare("SELECT count(*) AS n FROM state").get()!.n;
		for (const set of sets) {
			const actual = new View(graph, new StableOverlaySet(set));
			const expected = new View(repo.graph, set);
			const weight = actual.weight();
			t.mock.method(actual, "sequence", () => {
				throw new Error("historical sequence forbidden");
			});
			t.mock.method(actual, "sequenceIndex", () => {
				throw new Error("historical position index forbidden");
			});
			for (const path of ["a.txt", "b.txt", "missing.txt"]) {
				const sequence = expected.sequence(path);
				for (const line of ["a0.0", "a0.127", "a0.255", "a0.256", "a999.0"]) {
					const at = sequence.findIndex((item) => item.id === line);
					const before = at < 0 ? undefined : sequence.slice(0, at).findLast((item) => item.visible)?.id;
					const after = at < 0 ? undefined : sequence.slice(at + 1).find((item) => item.visible)?.id;
					assert.deepEqual(
						actual.visibleNeighbours(path, line),
						[before, after].filter((id) => id !== undefined),
					);
				}
			}
			assert.equal(actual.weight(), weight, "neighbour lookup retains no file/history projection");
			assert.equal(source.db.prepare("SELECT count(*) AS n FROM state").get()!.n, rows);
		}
	} finally {
		source.db.close();
	}
});
