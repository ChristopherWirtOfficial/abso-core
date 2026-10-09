// The graph: accepting atoms, indexes, lamport, closure, labels, JSON.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Atom, GRAPH_FORMAT, Graph, labelContents, View } from "../index.ts";
import { EditGen, filesFromView, filesToRecord, sameFiles } from "./gen.ts";
import { lines, Repo, Rng } from "./helpers.ts";

function reload(graph: Graph): Graph {
	return Graph.fromJSON(JSON.parse(JSON.stringify(graph)));
}

function sample(): { repo: Repo; x: Atom; y: Atom; z: Atom } {
	const repo = Repo.init({ "f.txt": lines("one", "two", "three") });
	const x = repo.edit({ author: "ann", message: "x", edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
	const y = repo.edit({
		author: "bob",
		message: "y",
		edits: [{ file: "f.txt", old: "ONE", new: "uno" }],
		reasons: [{ to: x.id, kind: "together", text: "same idea" }],
	});
	const z = repo.edit({
		author: "cy",
		message: "z",
		edits: [{ file: "f.txt", old: "three", new: "THREE" }],
		resolves: [x.id],
	});
	return { repo, x, y, z };
}

describe("graph.add", () => {
	it("requires the next id and seq", () => {
		const { repo, x } = sample();
		assert.throws(() => repo.graph.add({ ...x }), { code: "bad-atom" });
		assert.throws(() => repo.graph.add({ ...x, id: "a7", seq: 7 }), { code: "bad-atom" });
	});

	it("rejects touching lines from outside the closure, and other malformed atoms", () => {
		const { repo, x } = sample();
		const next = repo.graph.size;
		const base: Atom = { ...x, id: `a${next}`, seq: next, deps: ["a0"], needs: [], resolves: [], reasons: [] };
		// Deletes x's line without depending on x.
		assert.throws(() => repo.graph.add({ ...base, deletes: [`${x.id}.0`], writes: [`L:${x.id}.0`] }), {
			code: "bad-atom",
		});
		// Deletes a line without writing its key.
		assert.throws(() => repo.graph.add({ ...base, deletes: ["a0.1"], writes: [] }), { code: "bad-atom" });
		// Unknown dependency; needs outside deps; bad key. (A run may hang off a
		// line written in another file: a move can have taken the line there.)
		assert.throws(() => repo.graph.add({ ...base, deps: ["a99"] }), { code: "bad-atom" });
		assert.throws(() => repo.graph.add({ ...base, needs: [x.id] }), { code: "bad-atom" });
		assert.throws(() => repo.graph.add({ ...base, reads: ["X:nope"] }), { code: "bad-atom" });
		// Moves: without writing P: and G:, of an unknown line, after itself, twice.
		const move = { ...base, deletes: [], writes: ["G:^g.txt", "P:a0.0"] };
		assert.throws(() => repo.graph.add({ ...move, writes: ["P:a0.0"], moves: [{ line: "a0.0", parent: "^g.txt" }] }), {
			code: "bad-atom",
		});
		assert.throws(() => repo.graph.add({ ...move, moves: [{ line: "a9.0", parent: "^g.txt" }] }), { code: "bad-atom" });
		assert.throws(
			() => repo.graph.add({ ...move, writes: ["G:a0.0", "P:a0.0"], moves: [{ line: "a0.0", parent: "a0.0" }] }),
			{ code: "bad-atom" },
		);
		assert.throws(
			() =>
				repo.graph.add({
					...move,
					moves: [
						{ line: "a0.0", parent: "^g.txt" },
						{ line: "a0.0", parent: "^g.txt" },
					],
				}),
			{ code: "bad-atom" },
		);
		assert.throws(() => repo.graph.add({ ...move, moves: [] }), { code: "bad-atom" });
		assert.throws(
			() =>
				repo.graph.add({
					...base,
					deletes: [],
					writes: [],
					inserts: [{ file: "g.txt", parent: "^f.txt", lines: ["x"] }],
				}),
			{ code: "bad-atom" },
		);
		assert.throws(
			() =>
				repo.graph.add({
					...base,
					deletes: [],
					writes: [],
					inserts: [{ file: "f.txt", parent: "a0.0", lines: ["a\nb"] }],
				}),
			{ code: "bad-atom" },
		);
		assert.equal(repo.graph.size, next);
	});

	it("freezes accepted atoms", () => {
		const { repo, x } = sample();
		const stored = repo.graph.atom(x.id);
		assert.ok(Object.isFrozen(stored));
		assert.ok(Object.isFrozen(stored.inserts));
		assert.ok(Object.isFrozen(stored.inserts[0]!.lines));
		assert.throws(() => (stored.deps as string[]).push("a0"));
	});

	it("indexes lines, keys, dependents, resolvers and together links", () => {
		const { repo, x, y, z } = sample();
		const g = repo.graph;
		assert.deepEqual(g.line(`${x.id}.0`), {
			id: `${x.id}.0`,
			atom: x.id,
			k: 0,
			file: "f.txt",
			parent: "a0.0",
			text: "ONE",
		});
		assert.deepEqual(g.deletersOf("a0.0"), [x.id]);
		assert.deepEqual(g.writersOf(`L:${x.id}.0`), [y.id]);
		assert.deepEqual(g.dependentsOf(x.id), [y.id, z.id]);
		assert.deepEqual(g.resolversOf(x.id), [z.id]);
		assert.deepEqual(g.togetherLinks(x.id), [{ other: y.id, text: "same idea", from: y.id }]);
		assert.deepEqual(g.togetherLinks(y.id), [{ other: x.id, text: "same idea", from: y.id }]);
		assert.throws(() => g.atom("a99"), { code: "unknown-atom" });
		assert.throws(() => g.atom("nope"), { code: "unknown-atom" });
		assert.equal(g.has("a0.1"), false);
	});

	it("computes lamport from deps, closures, and dependsOn", () => {
		const { repo, x, y, z } = sample();
		const g = repo.graph;
		assert.deepEqual([g.lamport("a0"), g.lamport(x.id), g.lamport(y.id), g.lamport(z.id)], [0, 1, 2, 2]);
		assert.deepEqual([...g.closure(y.id)].sort(), ["a0", x.id, y.id].sort());
		assert.deepEqual([...g.closureOf([y.id, z.id])].sort(), ["a0", x.id, y.id, z.id].sort());
		assert.deepEqual([g.dependsOn(y.id, x.id), g.dependsOn(y.id, "a0"), g.dependsOn(y.id, y.id)], [true, true, true]);
		assert.deepEqual(
			[g.dependsOn(x.id, y.id), g.dependsOn(z.id, y.id), g.dependsOn(y.id, z.id)],
			[false, false, false],
		);
		assert.throws(() => g.dependsOn(y.id, "a99"), { code: "unknown-atom" });
		assert.ok(g.comparePriority(x.id, y.id) < 0);
		assert.ok(g.comparePriority(z.id, y.id) > 0);
	});

	it("dependsOn agrees with closure on branching histories (seeded)", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const rng = new Rng(seed);
			const gen = new EditGen(rng, { duplicates: rng.chance(0.5), wide: false });
			const repo = Repo.init(filesToRecord(gen.initialFiles()));
			const snapshots: Set<string>[] = [new Set(repo.shared)];
			for (let s = 0; s < 20; s++) {
				const against = rng.chance(0.4) ? rng.pick(snapshots) : repo.shared;
				const view = repo.view(against);
				const g = gen.next(filesFromView(view), view);
				if (!g || sameFiles(g.apply(filesFromView(view)), filesFromView(view))) continue;
				repo.edit({ edits: g.edits }, against);
				snapshots.push(new Set(repo.shared));
			}
			const ids = repo.graph.atoms().map((a) => a.id);
			for (const a of ids) {
				const inside = repo.graph.closure(a);
				for (const b of ids)
					assert.equal(repo.graph.dependsOn(a, b), inside.has(b), `seed ${seed}: dependsOn(${a}, ${b})`);
			}
		}
	});
});

describe("labels on the graph", () => {
	it("validates names, heads and bases", () => {
		const { repo, x, y } = sample();
		const g = repo.graph;
		g.setLabel({ name: "first", head: x.id, title: "First", message: "" });
		g.setLabel({ name: "second", head: y.id, base: "first", title: "Second", message: "", follows: ["first"] });
		assert.throws(() => g.setLabel({ name: "a5", head: x.id, title: "", message: "" }), { code: "bad-label" });
		assert.throws(() => g.setLabel({ name: "bad", head: "a99", title: "", message: "" }), { code: "bad-label" });
		assert.throws(() => g.setLabel({ name: "bad", head: x.id, base: "missing", title: "", message: "" }), {
			code: "bad-label",
		});
		assert.deepEqual(
			g.labels().map((l) => l.name),
			["first", "second"],
		);
		assert.equal(g.removeLabel("first"), true);
		assert.equal(g.label("first"), undefined);
		assert.equal(g.removeLabel("first"), false);
	});

	it("removing a label that another uses as its base gives that label the head atom as its base", () => {
		const { repo, x, y } = sample();
		const g = repo.graph;
		g.setLabel({ name: "release-1", head: x.id, title: "r1", message: "" });
		g.setLabel({ name: "feature", head: y.id, base: "release-1", title: "f", message: "", follows: ["release-1"] });
		const before = labelContents(g, g.label("feature")!);
		g.removeLabel("release-1");
		assert.deepEqual(g.label("feature"), {
			name: "feature",
			head: y.id,
			base: x.id,
			title: "f",
			message: "",
			follows: ["release-1"],
		});
		assert.deepEqual(labelContents(g, g.label("feature")!), before);
		assert.deepEqual(reload(g).labels(), g.labels());
	});

	it("bases may name each other in a cycle; each resolves to its head when used, and the graph reloads", () => {
		const { repo, x, y } = sample();
		const g = repo.graph;
		g.setLabel({ name: "y", head: y.id, base: "a0", title: "y", message: "" });
		g.setLabel({ name: "x", head: x.id, base: "y", title: "x", message: "" });
		g.setLabel({ name: "y", head: y.id, base: "x", title: "y", message: "" });
		assert.deepEqual(labelContents(g, g.label("y")!), [y.id]);
		assert.deepEqual(labelContents(g, g.label("x")!), []);
		assert.deepEqual(reload(g).labels(), g.labels());
	});
});

describe("JSON", () => {
	it("round-trips atoms and labels exactly", () => {
		const { repo, y } = sample();
		repo.graph.setLabel({ name: "base-label", head: "a0", title: "Import", message: "the import" });
		repo.graph.setLabel({
			name: "y-label",
			head: y.id,
			base: "base-label",
			title: "Y",
			message: "y",
			follows: ["base-label"],
		});
		const text = JSON.stringify(repo.graph);
		const parsed = JSON.parse(text);
		assert.equal(parsed.format, GRAPH_FORMAT);
		// Labels that name each other load in any order.
		parsed.labels.reverse();
		const again = Graph.fromJSON(parsed);
		assert.equal(JSON.stringify(again), text);
		assert.deepEqual(new View(again, repo.shared).files(), repo.files());
		assert.deepEqual(
			repo.graph.atoms().map((a) => again.lamport(a.id)),
			repo.graph.atoms().map((a) => repo.graph.lamport(a.id)),
		);
	});

	it("rejects other formats and tampered atoms", () => {
		const { repo, x } = sample();
		const data = JSON.parse(JSON.stringify(repo.graph));
		assert.throws(() => Graph.fromJSON(null), { code: "bad-json" });
		assert.throws(() => Graph.fromJSON({ ...data, format: "git" }), { code: "bad-json" });
		assert.throws(() => Graph.fromJSON({ ...data, version: 2 }), { code: "bad-json" });
		const tampered = structuredClone(data);
		tampered.atoms[Number(x.id.slice(1))].deps = [];
		assert.throws(() => Graph.fromJSON(tampered), { code: "bad-atom" });
		const dangling = structuredClone(data);
		dangling.labels = [{ name: "l", head: x.id, base: "nowhere", title: "", message: "" }];
		assert.throws(() => Graph.fromJSON(dangling), { code: "bad-json" });
	});
});
