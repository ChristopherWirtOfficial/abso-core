import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentalMarkerProjection as MarkerProjection } from "../experimental/projection-marker.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("typed marker projection matches mixed multi-file edits and reverse removals", () => {
	const db = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "a\nb\nc\n", "g.txt": "x\ny\n" }),
			graph = new Graph({ storage: new CachedStateStorage(db) });
		graph.add(repo.graph.atom("a0"));
		const p = new MarkerProjection(db, graph, "f.txt", "typed-mixed");
		let state = p.apply(p.empty(), repo.graph.atom("a0")),
			checks = 0;
		const atoms = [],
			roots = [];
		const check = () => {
			const view = repo.view();
			for (const path of ["f.txt", "g.txt"]) {
				assert.deepEqual(
					p.lines(state, path),
					view.lines(path).map((x) => x.id),
				);
				assert.deepEqual(p.attrs(state, path), view.attrs(path));
			}
			checks++;
		};
		for (let i = 0; i < 36; i++) {
			const file = i % 2 ? "f.txt" : "g.txt",
				other = i % 2 ? "g.txt" : "f.txt",
				view = repo.view();
			let input: Parameters<Repo["edit"]>[0];
			if (i % 3 === 0 && view.lines(file).length) input = { move: { file, start: 0, end: 1, to: other, at: 0 } };
			else if (i % 3 === 1)
				input = {
					edits: [{ file, old: view.text(file), new: `new ${i}\n${view.text(file)}` }],
					attrs: [{ file, name: "exec", value: i % 2 ? "1" : null }],
				};
			else input = { edits: [{ file, old: view.text(file), new: `rewrite ${i}\n` }] };
			const atom = repo.edit(input);
			graph.add(atom);
			atoms.push(atom);
			state = p.apply(state, atom);
			check();
			if (i % 9 === 0) roots.push({ state, f: p.lines(state, "f.txt"), g: p.lines(state, "g.txt") });
		}
		for (const atom of atoms.toReversed()) {
			repo.shared.delete(atom.id);
			state = p.removeAtom(state, atom);
			check();
		}
		for (const root of roots) {
			assert.deepEqual(p.lines(root.state, "f.txt"), root.f);
			assert.deepEqual(p.lines(root.state, "g.txt"), root.g);
		}
		assert.equal(checks, 72);
	} finally {
		db.db.close();
	}
});

test("typed marker namespaces isolate file identities and temporary metadata", () => {
	const storage = new SqlState();
	try {
		const repo = Repo.init({ "f.txt": "f\n", "g.txt": "g\n" });
		const graph = new Graph({ storage: new CachedStateStorage(storage) });
		graph.add(repo.graph.atom("a0"));
		const alpha = new MarkerProjection(storage, graph, "f.txt", "alpha");
		const beta = new MarkerProjection(storage, graph, "g.txt", "beta");
		const a = alpha.apply(alpha.empty(), repo.graph.atom("a0"));
		const b = beta.apply(beta.empty(), repo.graph.atom("a0"));
		const wrongFile = new MarkerProjection(storage, graph, "g.txt", "alpha");
		for (const other of [beta, wrongFile]) {
			const reads = storage.reads,
				writes = storage.writes;
			assert.throws(() => other.lines(a, "f.txt"), /constructor context mismatch/);
			assert.throws(() => other.apply(a, repo.graph.atom("a0")), /constructor context mismatch/);
			assert.equal(storage.reads, reads);
			assert.equal(storage.writes, writes);
		}

		for (const path of ["f.txt", "g.txt"]) {
			assert.deepEqual(
				alpha.lines(a, path),
				repo
					.view()
					.lines(path)
					.map((x) => x.id),
			);
			assert.deepEqual(
				beta.lines(b, path),
				repo
					.view()
					.lines(path)
					.map((x) => x.id),
			);
		}
		alpha.storage.write("sequence-meta", "work-scope", 91);
		assert.equal(beta.storage.read("sequence-meta", "work-scope"), undefined);
		const rows = () => JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows();
		assert.throws(
			() => alpha.relocateBatch(a, [{ n: -1, parentKey: 0, key: "0".repeat(57) }]),
			/invalid relocation plan/,
		);
		assert.equal(rows(), before);
		assert.deepEqual(
			beta.lines(b, "f.txt"),
			repo
				.view()
				.lines("f.txt")
				.map((x) => x.id),
		);
	} finally {
		storage.db.close();
	}
});
