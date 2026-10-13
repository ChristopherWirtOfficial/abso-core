import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentalMarkerProjection as MarkerProjection } from "../experimental/projection-marker.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import { Repo, Rng } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("typed marker move transaction rolls back each selected phase", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "a\nb\nc\n" }),
			graph = new Graph({ storage: new CachedStateStorage(db) });
		graph.add(repo.graph.atom("a0"));
		const p = new MarkerProjection(db, graph, "f.txt", "typed-" + "move-failures"),
			before = p.apply(p.empty(), repo.graph.atom("a0"));
		const atom = repo.edit({ move: { file: "f.txt", start: 0, end: 1, to: "f.txt", at: 3 } });
		graph.add(atom);
		const originalWrite = db.write.bind(db),
			originalRemove = db.remove.bind(db),
			events: { kind: string; collection: string; key: string }[] = [];
		db.write = (collection, key, value) => {
			events.push({ kind: "write", collection, key });
			return originalWrite(collection, key, value);
		};
		db.remove = (collection, key) => {
			events.push({ kind: "remove", collection, key });
			return originalRemove(collection, key);
		};
		const sentinel = Error("rollback measured success");
		assert.throws(
			() =>
				db.transaction(() => {
					p.apply(before, atom);
					throw sentinel;
				}),
			(e) => e === sentinel,
		);
		db.write = originalWrite;
		db.remove = originalRemove;
		const offsets = new Set([0, events.length - 1]);
		for (const prefix of ["sequence-resolver:", "sequence-relocation-work:"]) {
			offsets.add(events.findIndex((e) => e.collection.includes(prefix)));
			offsets.add(events.findIndex((e) => e.kind === "remove" && e.collection.includes(prefix)));
		}
		const plan = events.findIndex((e) => e.collection.includes("sequence-relocation-work:"));
		offsets.add(events.findIndex((e, i) => i > plan && e.collection.includes(":sequence")));
		const rows = () => JSON.stringify(db.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const baseline = rows(),
			results = [];
		for (const offset of [...offsets].filter((n) => n >= 0).sort((a, b) => a - b)) {
			let cursor = 0;
			const fail = () => {
				if (cursor++ === offset) throw Error("injected phase failure");
			};
			db.write = (c, k, v) => {
				fail();
				return originalWrite(c, k, v);
			};
			db.remove = (c, k) => {
				fail();
				return originalRemove(c, k);
			};
			assert.throws(() => p.apply(before, atom), /injected phase failure/);
			db.write = originalWrite;
			db.remove = originalRemove;
			assert.equal(rows(), baseline);
			assert.deepEqual(p.lines(before), ["a0.0", "a0.1", "a0.2"]);
			results.push({ offset, ...events[offset] });
		}
		const state = p.apply(before, atom);
		assert.deepEqual(
			p.lines(state),
			repo
				.view()
				.lines("f.txt")
				.map((x) => x.id),
		);
		const writes = db.writes;
		assert.equal(p.apply(state, atom), state);
		assert.equal(db.writes, writes);
		assert.equal(results.length, 7);
	} finally {
		db.db.close();
	}
});
