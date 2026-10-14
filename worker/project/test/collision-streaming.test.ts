import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../../../src/engine/index.ts";
import { CachedStateStorage, StableOverlaySet, unionOverlay } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { type CollisionHost, openPairs, pairsIn } from "../collisions.ts";
import type { AgentState } from "../project-types.ts";
import { newSpace } from "../spaces.ts";

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
		const base = new StableOverlaySet(against);
		t.mock.method(base, "values", () => {
			throw Error("enumerating the complete base membership is forbidden");
		});
		const actor: AgentState = {
			name: "fixture",
			space: "",
			base: 0,
			synced: true,
			mine: ["a1", draft],
			news: [],
			newsAt: [],
			told: new Set(),
			parked: new Map(),
			marked: [],
		};
		const space = newSpace("");
		const host: CollisionHost = {
			graph: reopened,
			spaces: new Map([["", space]]),
			version: () => 0,
			spaceOf: () => space,
			agentSet: (agent) => unionOverlay(base, agent.mine),
			draft: () => [draft],
			at: () => base,
			shared: () => space,
			agentView: () => {
				throw Error("open pairs must not build a View");
			},
		};
		assert.deepEqual(
			openPairs(host, actor).map((pair) => pair.theirs),
			[...against].filter((id) => id !== "a1"),
		);
	} finally {
		source.db.close();
	}
});

test("wide claim merging reads each stream head once and closes streams on failure", () => {
	const count = 256;
	let reads = 0,
		opened = 0,
		closed = 0;
	let fail = false;
	const draft = {
		seq: 3,
		writes: Array.from({ length: count }, (_, n) => `L:a0.${n}`),
		reads: [],
		holds: [],
		inserts: [],
		deletes: [],
		deps: [],
		resolves: [],
		needs: [],
		reasons: [],
	};
	const stream = function* () {
		opened++;
		try {
			yield "a0";
			yield "a1";
			if (fail) throw Error("claim stream failure");
			yield "a2";
		} finally {
			closed++;
		}
	};
	const graph = {
		atom: (id: string) => {
			reads++;
			return id === "a3" ? draft : { seq: Number(id.slice(1)) };
		},
		eachWriterOf: stream,
		eachReaderOf: stream,
		eachHolderOf: stream,
	} as unknown as Graph;
	assert.deepEqual(pairsIn(graph, ["a3"], new Set(), new Set()), []);
	assert.ok(reads <= count * 12 + 1, `Unexpected repeated head reads: ${reads}`);
	assert.equal(closed, opened);
	fail = true;
	opened = 0;
	closed = 0;
	assert.throws(() => pairsIn(graph, ["a3"], new Set(), new Set()), /claim stream failure/);
	assert.equal(closed, opened);
});
