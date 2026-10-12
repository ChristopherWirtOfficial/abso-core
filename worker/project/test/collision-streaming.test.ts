import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../../../src/engine/index.ts";
import { CachedStateStorage } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { pairsIn } from "../collisions.ts";

test("persistent conflict candidates and resolver intersections stream in exact canonical order", (t) => {
	const source = new SqlState();
	try {
		const graph = new Graph({ storage: new CachedStateStorage(source, 8192, 32) });
		graph.add(buildBase({ "a.txt": "one\n" }, { author: "fixture", message: "base", time: 0 }));
		const count = 513;
		for (let seq = 1; seq <= count + 1; seq++)
			graph.add({
				id: `a${seq}`,
				seq,
				author: "fixture",
				message: "claim",
				time: seq,
				inserts: [],
				deletes: [],
				writes: ["L:a0.0"],
				reads: ["G:^a.txt"],
				holds: [],
				needs: [],
				resolves: [],
				reasons: [],
				deps: ["a0"],
			});
		const draft = `a${count + 1}`;
		const against = new Set(Array.from({ length: count }, (_, n) => `a${n + 1}`));
		const settled = new Set<string>();
		for (let n = 1; n <= count; n += 2) {
			const seq = graph.size;
			const id = `a${seq}`;
			graph.add({
				id,
				seq,
				author: "fixture",
				message: "resolve",
				time: seq,
				inserts: [],
				deletes: [],
				writes: [],
				reads: [],
				holds: [],
				needs: [],
				resolves: [`a${n}`, draft],
				reasons: [],
				deps: [`a${n}`, draft],
			});
			settled.add(id);
		}
		const reopened = new Graph({ storage: new CachedStateStorage(source, 8192, 32) });
		for (const method of ["writersOf", "readersOf", "holdersOf", "resolversOf"] as const)
			t.mock.method(reopened, method, () => {
				throw new Error(`materialized ${method} forbidden`);
			});
		assert.deepEqual(
			pairsIn(reopened, [draft], against, new Set()).map((pair) => pair.theirs),
			[...against],
		);
		assert.deepEqual(
			pairsIn(reopened, [draft], against, settled).map((pair) => pair.theirs),
			[...against].filter((id) => Number(id.slice(1)) % 2 === 0),
		);
		const selected = new Set(["a1", "a257", "a513"]);
		assert.deepEqual(pairsIn(reopened, [draft], selected, settled), []);
	} finally {
		source.db.close();
	}
});
