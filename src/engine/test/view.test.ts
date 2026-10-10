// Projection: the line tree, tombstones, sibling priority, and long files.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBase, conflicts, Graph, project, View } from "../index.ts";
import { lines, Repo } from "./helpers.ts";

describe("View", () => {
	it("keeps deleted lines as tombstones in the full sequence", () => {
		const repo = Repo.init({ "f.txt": lines("one", "two", "three") });
		const del = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "" }] });
		const view = repo.view();
		assert.deepEqual(
			view.sequence("f.txt").map((l) => [l.id, l.text, l.visible, l.deletedBy]),
			[
				["a0.0", "one", true, []],
				["a0.1", "two", false, [del.id]],
				["a0.2", "three", true, []],
			],
		);
		assert.deepEqual(
			view.lines("f.txt").map((l) => l.id),
			["a0.0", "a0.2"],
		);
		assert.equal(view.lineNumber("f.txt", "a0.2"), 1);
		assert.equal(view.lineNumber("f.txt", "a0.1"), -1);
		assert.equal(view.sequenceIndex("f.txt", "a0.1"), 1);
		assert.equal(view.text("f.txt"), "one\nthree\n");
		assert.equal(view.text("missing.txt"), "");
		assert.deepEqual(view.lines("missing.txt"), []);
	});

	it("orders siblings by descending priority: higher lamport first, then higher seq", () => {
		const repo = Repo.init({ "f.txt": lines("top", "bottom") });
		// Three inserts after "top", all written against the base: same lamport, seq decides.
		const p = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 1, lines: ["p"] }] }, ["a0"]);
		const q = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 1, lines: ["q"] }] }, ["a0"]);
		assert.equal(repo.text("f.txt"), lines("top", "q", "p", "bottom"));
		// One written later, against a view with both: higher lamport, lands right after "top".
		const r = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 1, lines: ["r"] }] });
		assert.ok(repo.graph.lamport(r.id) > repo.graph.lamport(q.id));
		assert.equal(repo.text("f.txt"), lines("top", "r", "q", "p", "bottom"));
		assert.deepEqual(
			r.deps,
			["a0", p.id, q.id].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
		);
	});

	it("puts a line's replacements ahead of the lines inserted after it, whatever their priority", () => {
		const repo = Repo.init({ "f.txt": lines("x", "y") });
		const y1 = repo.edit({ edits: [{ file: "f.txt", old: "y", new: "y1" }] });
		const y2 = repo.edit({ edits: [{ file: "f.txt", old: "y1", new: "y2" }] });
		// A before-mode insert above y2: it hangs off x and depends on y2's writer (lamport 3).
		const before = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 1, lines: ["n"], mode: "before" }] });
		assert.equal(repo.graph.lamport(before.id), 3);
		// A replacement of x written against the base (lamport 1); the two don't conflict.
		const replace = repo.edit({ edits: [{ file: "f.txt", old: "x", new: "X" }] }, ["a0"]);
		assert.equal(repo.graph.lamport(replace.id), 1);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(repo.text("f.txt"), lines("X", "n", "y2"));
		assert.deepEqual(
			repo
				.view()
				.sequence("f.txt")
				.map((l) => l.id),
			["a0.0", `${replace.id}.0`, `${before.id}.0`, "a0.1", `${y1.id}.0`, `${y2.id}.0`],
		);
	});

	it("refuses sets that are not closed or name unknown atoms", () => {
		const repo = Repo.init({ "f.txt": lines("one") });
		const x = repo.edit({ edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
		assert.throws(() => new View(repo.graph, [x.id]), { code: "not-closed" });
		assert.throws(() => new View(repo.graph, ["a0", "a9"]), { code: "unknown-atom" });
		assert.deepEqual(new View(repo.graph, []).files(), {});
	});

	it("projects a long file (a deep chain) without recursion limits", () => {
		const big = Array.from({ length: 30_000 }, (_, i) => `line ${i}`);
		const graph = new Graph();
		graph.add(buildBase({ "big.txt": `${big.join("\n")}\n` }, { author: "import", message: "big" }));
		const files = project(graph, ["a0"]);
		assert.equal(files["big.txt"]!.split("\n").length, 30_001);
	});

	it("lists known paths separately from existing files", () => {
		const repo = Repo.init({ "a.txt": lines("a"), "b.txt": lines("b") });
		repo.edit({ edits: [{ file: "b.txt", old: "b\n", new: "" }] });
		const view = repo.view();
		assert.deepEqual(view.paths(), ["a.txt"]);
		assert.deepEqual(view.knownPaths(), ["a.txt", "b.txt"]);
		assert.deepEqual(view.files(), { "a.txt": "a\n" });
	});
});
