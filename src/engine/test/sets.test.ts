// Sets and labels: closure, closedness, history, drop, refs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	closure,
	dependentsIn,
	drop,
	history,
	isClosed,
	labelContents,
	labelsContaining,
	missingDeps,
	resolveRef,
	stateOf,
} from "../index.ts";
import { lines, Repo } from "./helpers.ts";

function chain() {
	const repo = Repo.init({ "f.txt": lines("one", "two", "three") });
	const a = repo.edit({ edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
	const b = repo.edit({ edits: [{ file: "f.txt", old: "ONE", new: "uno" }] });
	const c = repo.edit({ edits: [{ file: "f.txt", old: "three", new: "THREE" }] });
	const d = repo.edit({ message: "tie", needs: [b.id, c.id] });
	return { repo, a, b, c, d };
}

describe("sets", () => {
	it("closure and closedness", () => {
		const { repo, a, b, c, d } = chain();
		assert.deepEqual([...closure(repo.graph, [b.id])].sort(), ["a0", a.id, b.id].sort());
		assert.deepEqual([...closure(repo.graph, [b.id, c.id])].sort(), ["a0", a.id, b.id, c.id].sort());
		assert.equal(isClosed(repo.graph, repo.shared), true);
		const open = new Set(["a0", b.id, d.id]);
		assert.equal(isClosed(repo.graph, open), false);
		assert.deepEqual(missingDeps(repo.graph, open), [
			{ atom: b.id, missing: [a.id] },
			{ atom: d.id, missing: [c.id] },
		]);
	});

	it("history is ascending (lamport, seq)", () => {
		const { repo, a, b, c, d } = chain();
		assert.deepEqual(
			history(repo.graph, repo.shared).map((x) => x.id),
			["a0", a.id, c.id, b.id, d.id],
		);
	});

	it("drop removes dependents transitively, only within the set", () => {
		const { repo, a, b, c, d } = chain();
		assert.deepEqual([...dependentsIn(repo.graph, repo.shared, a.id)].sort(), [b.id, d.id].sort());
		const out = drop(repo.graph, repo.shared, a.id);
		assert.deepEqual(out.removed, [a.id, b.id, d.id]);
		assert.deepEqual([...out.set].sort(), ["a0", c.id].sort());
		assert.equal(isClosed(repo.graph, out.set), true);
		assert.deepEqual(repo.files(out.set), { "f.txt": lines("one", "two", "THREE") });
		assert.throws(() => drop(repo.graph, out.set, a.id), { code: "not-in-set" });
		// The original set is untouched.
		assert.ok(repo.shared.has(a.id));
	});
});

describe("labels", () => {
	it("resolve refs, compute contents with label or atom bases, and find labels holding an atom", () => {
		const { repo, a, b, c, d } = chain();
		const g = repo.graph;
		g.setLabel({ name: "first", head: b.id, title: "First", message: "" });
		g.setLabel({ name: "all", head: d.id, base: "first", title: "All", message: "" });
		assert.equal(resolveRef(g, "first"), b.id);
		assert.equal(resolveRef(g, c.id), c.id);
		assert.throws(() => resolveRef(g, "nope"), { code: "unknown-ref" });
		assert.deepEqual([...stateOf(g, "first")].sort(), ["a0", a.id, b.id].sort());
		assert.deepEqual(labelContents(g, g.label("first")!), [a.id, b.id]);
		assert.deepEqual(labelContents(g, g.label("all")!), [c.id, d.id]);
		assert.deepEqual(labelContents(g, { head: d.id, base: a.id }), [c.id, b.id, d.id]);
		assert.deepEqual(
			labelsContaining(g, a.id).map((l) => l.name),
			["first"],
		);
		assert.deepEqual(
			labelsContaining(g, c.id).map((l) => l.name),
			["all"],
		);
	});
});
