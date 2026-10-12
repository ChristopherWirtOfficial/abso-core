// Building atoms from edits: matching, hunks, keys, modes, deps, errors.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Atom,
	buildAtom,
	buildBase,
	canonicalText,
	checkDraft,
	conflicts,
	drop,
	EngineError,
	Graph,
	gapKey,
	lineKey,
	type Mode,
	project,
	View,
} from "../index.ts";
import { lines, Repo, Rng } from "./helpers.ts";

const FIVE = lines("one", "two", "three", "four", "five");

describe("replacement", () => {
	it("deletes the old lines, hangs the new ones off the last deleted line, and writes each deleted line", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "two\nthree\n", new: "TWO\nTHREE\nextra\n" }] });
		assert.deepEqual(atom.deletes, ["a0.1", "a0.2"]);
		assert.deepEqual(atom.inserts, [{ file: "f.txt", parent: "a0.2", lines: ["TWO", "THREE", "extra"] }]);
		assert.deepEqual(atom.writes, [lineKey("a0.1"), lineKey("a0.2")]);
		assert.deepEqual(atom.reads, []);
		assert.deepEqual(atom.holds, []);
		assert.equal(repo.text("f.txt"), lines("one", "TWO", "THREE", "extra", "four", "five"));
	});

	it("does not depend on the writer of the line below the last deleted one", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const four = repo.edit({ edits: [{ file: "f.txt", old: "four", new: "FOUR" }] });
		// Replacing two..three: the next visible line after "three" is four's replacement.
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "two\nthree\n", new: "x\n" }] });
		assert.deepEqual(atom.deps, ["a0"]);
		assert.equal(repo.text("f.txt"), lines("one", "x", "FOUR", "five"));
		// Its closure has the old "four" below it, and dropping four's edit keeps it.
		assert.equal(repo.text("f.txt", repo.graph.closure(atom.id)), lines("one", "x", "four", "five"));
		assert.deepEqual(drop(repo.graph, repo.shared, four.id).removed, [four.id]);
	});

	it("a deletion-only hunk inserts nothing and has no placement deps", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		repo.edit({ edits: [{ file: "f.txt", old: "four", new: "FOUR" }] });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "three\n", new: "" }] });
		assert.deepEqual(atom.inserts, []);
		assert.deepEqual(atom.deps, ["a0"]);
	});

	it("claims only the lines the line diff changes, not unchanged context inside old", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "two\nthree\nfour\n", new: "TWO\nthree\nFOUR\n" }] });
		assert.deepEqual(atom.deletes, ["a0.1", "a0.3"]);
		assert.deepEqual(atom.writes, [lineKey("a0.1"), lineKey("a0.3")]);
		assert.deepEqual(
			atom.inserts.map((r) => r.parent),
			["a0.1", "a0.3"],
		);
	});
});

describe("pure insertion modes", () => {
	const insert = (mode: Mode): Atom => {
		const repo = Repo.init({ "f.txt": FIVE });
		return repo.edit({ edits: [{ file: "f.txt", old: "two\nthree\n", new: "two\nnew\nthree\n", mode }] });
	};

	it("both: writes the gap, reads the line above and the line below", () => {
		const atom = insert("both");
		assert.deepEqual(atom.inserts, [{ file: "f.txt", parent: "a0.1", lines: ["new"] }]);
		assert.deepEqual(atom.writes, [gapKey("a0.1")]);
		assert.deepEqual(atom.reads, [lineKey("a0.1"), lineKey("a0.2")]);
		assert.deepEqual(atom.holds, []);
	});

	it("after: reads only the line above", () => {
		const atom = insert("after");
		assert.deepEqual(atom.writes, [gapKey("a0.1")]);
		assert.deepEqual(atom.reads, [lineKey("a0.1")]);
	});

	it("before: reads only the line below, still hangs off the line above and depends on its writer", () => {
		const atom = insert("before");
		assert.deepEqual(atom.inserts, [{ file: "f.txt", parent: "a0.1", lines: ["new"] }]);
		assert.deepEqual(atom.writes, [gapKey("a0.1")]);
		assert.deepEqual(atom.reads, [lineKey("a0.2")]);
		assert.deepEqual(atom.deps, ["a0"]);
	});

	it("at the edge of a file, after and before read the one neighbour there is", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const top = repo.draft({ edits: [{ file: "f.txt", start: 0, end: 0, lines: ["zero"], mode: "after" }] });
		assert.deepEqual(top.writes, [gapKey("^f.txt")]);
		assert.deepEqual(top.reads, [lineKey("a0.0")]);
		const bottom = repo.draft({ edits: [{ file: "f.txt", start: 5, end: 5, lines: ["six"], mode: "before" }] });
		assert.deepEqual(bottom.writes, [gapKey("a0.4")]);
		assert.deepEqual(bottom.reads, [lineKey("a0.4")]);
		// So an insertion at the top conflicts with deleting the whole file concurrently.
		repo.edit({ edits: [{ file: "f.txt", old: FIVE, new: "" }] }, ["a0"]);
		repo.edit({ edits: [{ file: "f.txt", start: 0, end: 0, lines: ["// header"], mode: "after" }] }, ["a0"]);
		assert.equal(conflicts(repo.graph, repo.shared).length, 1);
	});

	it("wide: also holds every line of old and the gaps between them", () => {
		const atom = insert("wide");
		assert.deepEqual(atom.reads, [lineKey("a0.1"), lineKey("a0.2")]);
		assert.deepEqual(atom.holds, [gapKey("a0.1"), lineKey("a0.1"), lineKey("a0.2")]);
	});

	it("at the top of a file it writes the start gap and reads only the line below", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "one\n", new: "zero\none\n" }] });
		assert.deepEqual(atom.inserts, [{ file: "f.txt", parent: "^f.txt", lines: ["zero"] }]);
		assert.deepEqual(atom.writes, [gapKey("^f.txt")]);
		assert.deepEqual(atom.reads, [lineKey("a0.0")]);
	});

	it("at the end of a file it reads only the line above", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "five\n", new: "five\nsix\n" }] });
		assert.deepEqual(atom.writes, [gapKey("a0.4")]);
		assert.deepEqual(atom.reads, [lineKey("a0.4")]);
		assert.equal(repo.text("f.txt"), `${FIVE}six\n`);
	});
});

describe("matching old text", () => {
	it("widens a match inside a line to the whole line", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "hre", new: "HRE" }] });
		assert.deepEqual(atom.deletes, ["a0.2"]);
		assert.equal(repo.text("f.txt"), lines("one", "two", "tHREe", "four", "five"));
	});

	it("widens a match across two partial lines", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		repo.edit({ edits: [{ file: "f.txt", old: "ree\nfo", new: "REE\nFO" }] });
		assert.equal(repo.text("f.txt"), lines("one", "two", "thREE", "FOur", "five"));
	});

	it("joins the next line when the replacement removes a line break, like plain text does", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "two " }] });
		assert.deepEqual(atom.deletes, ["a0.1", "a0.2"]);
		assert.equal(repo.text("f.txt"), lines("one", "two three", "four", "five"));
		// At the end of the file there is no next line; a file always ends with a newline, so it is a no-op.
		assert.throws(() => repo.draft({ edits: [{ file: "f.txt", old: "five\n", new: "five" }] }), { code: "empty-atom" });
		repo.edit({ edits: [{ file: "f.txt", old: "four\nfive\n", new: "four\nfive and more" }] });
		assert.equal(repo.text("f.txt"), lines("one", "two three", "four", "five and more"));
	});

	it("normalizes CRLF in old and new", () => {
		const repo = Repo.init({ "f.txt": "one\r\ntwo\r\n" });
		repo.edit({ edits: [{ file: "f.txt", old: "one\r\ntwo", new: "uno\r\ndos" }] });
		assert.equal(repo.text("f.txt"), "uno\ndos\n");
	});

	it("rejects text that is missing, ambiguous, or empty in a non-empty file", () => {
		const repo = Repo.init({ "f.txt": lines("x", "x", "y") });
		const view = repo.view();
		const build = (old: string) => () =>
			buildAtom(view, { author: "a", message: "m", edits: [{ file: "f.txt", old, new: "z" }] });
		assert.throws(build("nope"), { code: "no-match" });
		assert.throws(build("x"), { code: "ambiguous-match" });
		assert.throws(build(""), { code: "ambiguous-match" });
		assert.doesNotThrow(build("x\ny"));
	});

	it("rejects overlapping edits in one atom", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		assert.throws(
			() =>
				repo.draft({
					edits: [
						{ file: "f.txt", old: "two\nthree", new: "a" },
						{ file: "f.txt", old: "three\nfour", new: "b" },
					],
				}),
			{ code: "overlapping-edits" },
		);
	});

	// Step 1 widens a partial match to whole lines, and line endings are
	// normalized, so an accepted text edit must project exactly like plain string
	// replacement followed by that normalization, for any unique substring:
	// mid-line starts and ends, spans across line breaks, the final newline,
	// CRLF in the new text, and empty new text.
	it("projects exactly like plain string replacement, for arbitrary unique substrings (seeded)", () => {
		const alphabet = ["a", "b", "c", " ", "\n", "\n"];
		let checked = 0;
		let noops = 0;
		for (let seed = 1; seed <= 3000; seed++) {
			const rng = new Rng(seed);
			let text = "";
			for (let i = rng.range(1, 14); i > 0; i--) text += rng.pick(alphabet);
			text = canonicalText(text);
			if (text === "") continue;
			const s = rng.int(text.length);
			const e = rng.range(s + 1, text.length);
			const old = text.slice(s, e);
			if (text.indexOf(old, text.indexOf(old) + 1) >= 0) continue;
			let replacement = "";
			for (let i = rng.range(0, 5); i > 0; i--) replacement += rng.pick(alphabet);
			if (rng.chance(0.2)) replacement = replacement.replace(/\n/g, "\r\n");
			const expected = canonicalText(text.slice(0, s) + replacement + text.slice(e));
			const graph = new Graph();
			graph.add(buildBase({ f: text }, { author: "import", message: "snapshot" }));
			const set = new Set(["a0"]);
			const context = `seed ${seed}: ${JSON.stringify({ text, old, replacement })}`;
			let atom;
			try {
				atom = buildAtom(new View(graph, set), {
					author: "x",
					message: "x",
					edits: [{ file: "f", old, new: replacement }],
				});
			} catch (err) {
				// A no-op (after normalization) is the only acceptable refusal.
				assert.ok(
					err instanceof EngineError && err.code === "empty-atom" && expected === text,
					`${context}: ${String(err)}`,
				);
				noops++;
				continue;
			}
			graph.add(atom);
			set.add(atom.id);
			assert.equal(new View(graph, set).text("f"), expected, context);
			checked++;
		}
		assert.ok(checked > 1500, `only ${checked} edits checked`);
		assert.ok(noops > 0);
	});

	it("rejects an edit that changes and claims nothing", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		assert.throws(() => repo.draft({ edits: [{ file: "f.txt", old: "two", new: "two" }] }), { code: "empty-atom" });
		// The same no-op in wide mode is a claim on the span.
		const claim = repo.draft({ edits: [{ file: "f.txt", old: "two", new: "two", mode: "wide" }] });
		assert.deepEqual(claim.holds, [lineKey("a0.1")]);
	});
});

describe("splice edits", () => {
	it("replace visible lines by index, diffing old against new", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 3, lines: ["two", "TRES"] }] });
		assert.deepEqual(atom.deletes, ["a0.2"]);
		assert.equal(repo.text("f.txt"), lines("one", "two", "TRES", "four", "five"));
	});

	it("insert at start === end, including the very top and bottom", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		repo.edit({ edits: [{ file: "f.txt", start: 0, end: 0, lines: ["zero"] }] });
		repo.edit({ edits: [{ file: "f.txt", start: 6, end: 6, lines: ["six"] }] });
		assert.equal(repo.text("f.txt"), lines("zero", "one", "two", "three", "four", "five", "six"));
	});

	it("a large edit is still a minimal line diff: changing the ends of 2100 lines deletes two", () => {
		const n = 2100;
		const base = Array.from({ length: n }, (_, i) => `line ${i}`);
		const repo = Repo.init({ "big.txt": lines(...base) });
		const next = [...base];
		next[0] = "FIRST";
		next[n - 1] = "LAST";
		const draft = repo.draft({ edits: [{ file: "big.txt", start: 0, end: n, lines: next }] });
		assert.deepEqual(draft.deletes, ["a0.0", `a0.${n - 1}`]);
		// So a concurrent edit to the middle of the file does not collide with it.
		const middle = repo.draft({ edits: [{ file: "big.txt", old: "line 1000\n", new: "line one thousand\n" }] }, ["a0"]);
		assert.deepEqual(
			draft.writes.filter((k) => middle.writes.includes(k)),
			[],
		);
	});

	it("reject bad ranges and lines with breaks", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		assert.throws(() => repo.draft({ edits: [{ file: "f.txt", start: 3, end: 2, lines: [] }] }), { code: "bad-range" });
		assert.throws(() => repo.draft({ edits: [{ file: "f.txt", start: 0, end: 9, lines: [] }] }), { code: "bad-range" });
		assert.throws(() => repo.draft({ edits: [{ file: "f.txt", start: 0, end: 1, lines: ["a\nb"] }] }), {
			code: "bad-edit",
		});
	});
});

describe("several edits in one atom", () => {
	it("numbers inserted lines across all runs, in file then position order", () => {
		const repo = Repo.init({ "a.txt": lines("a1", "a2"), "b.txt": lines("b1") });
		const atom = repo.edit({
			edits: [
				{ file: "b.txt", old: "b1\n", new: "b1\nB\n" },
				{ file: "a.txt", old: "a2\n", new: "a2\nA2\n" },
				{ file: "a.txt", old: "a1\n", new: "A1\n" },
			],
		});
		assert.deepEqual(
			atom.inserts.map((r) => [r.file, r.parent, r.lines]),
			[
				["b.txt", "a0.2", ["B"]],
				["a.txt", "a0.0", ["A1"]],
				["a.txt", "a0.1", ["A2"]],
			],
		);
		assert.deepEqual(repo.graph.linesOf(atom.id), [`${atom.id}.0`, `${atom.id}.1`, `${atom.id}.2`]);
		assert.equal(repo.graph.line(`${atom.id}.1`)!.text, "A1");
		assert.deepEqual(repo.files(), { "a.txt": lines("A1", "a2", "A2"), "b.txt": lines("b1", "B") });
	});

	it("two insertions into the same gap keep their text order", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.edit({
			edits: [
				{ file: "f.txt", start: 2, end: 2, lines: ["first"] },
				{ file: "f.txt", start: 2, end: 2, lines: ["second"] },
				{ file: "f.txt", start: 2, end: 3, lines: ["third", "THREE"] },
			],
		});
		assert.equal(atom.inserts.length, 3);
		assert.equal(repo.text("f.txt"), lines("one", "two", "first", "second", "third", "THREE", "four", "five"));
	});
});

describe("files", () => {
	it("creates a file with an empty old text, deletes it by deleting every line, and recreates it", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const created = repo.edit({ edits: [{ file: "g.txt", old: "", new: "g1\ng2" }] });
		assert.deepEqual(created.deps, []);
		assert.equal(repo.text("g.txt"), "g1\ng2\n");
		const edited = repo.edit({ edits: [{ file: "g.txt", old: "g2", new: "G2" }] });
		const removed = repo.edit({ edits: [{ file: "g.txt", old: "g1\nG2\n", new: "" }] });
		assert.deepEqual(removed.deps, [edited.id]);
		assert.deepEqual(repo.graph.closureOf(removed.deps), repo.graph.closureOf([created.id, edited.id]));
		assert.equal(repo.view().hasFile("g.txt"), false);
		assert.deepEqual(Object.keys(repo.files()), ["f.txt"]);
		assert.deepEqual(repo.view().knownPaths(), ["f.txt", "g.txt"]);
		// Recreating lands in front of the tombstones. It depends on the atom whose
		// lines hang off the start (gap rule) and on the deletions: it relies on
		// the file being empty, so its closure shows only the new text.
		const again = repo.edit({ edits: [{ file: "g.txt", old: "", new: "fresh\n" }] });
		assert.deepEqual(again.deps, [removed.id]);
		assert.deepEqual(repo.graph.closureOf(again.deps), repo.graph.closureOf([created.id, edited.id, removed.id]));
		assert.equal(repo.text("g.txt"), "fresh\n");
		assert.equal(repo.text("g.txt", repo.graph.closure(again.id)), "fresh\n");
	});

	it("a path may start with '^' (its start node is '^^...')", () => {
		const graph = new Graph();
		graph.add(
			buildBase({ "^notes.txt": lines("one"), "a.txt": lines("a") }, { author: "import", message: "snapshot" }),
		);
		const set = new Set(["a0"]);
		assert.equal(new View(graph, set).text("^notes.txt"), lines("one"));
		assert.deepEqual(graph.atom("a0").writes, [gapKey("^^notes.txt"), gapKey("^a.txt")]);
		const edit = buildAtom(new View(graph, set), {
			author: "x",
			message: "x",
			edits: [{ file: "^notes.txt", old: "one", new: "ONE" }],
		});
		graph.add(edit);
		set.add(edit.id);
		const top = buildAtom(new View(graph, set), {
			author: "x",
			message: "x",
			edits: [{ file: "^notes.txt", start: 0, end: 0, lines: ["zero"] }],
		});
		graph.add(top);
		set.add(top.id);
		assert.equal(project(graph, set)["^notes.txt"], lines("zero", "ONE"));
		assert.deepEqual(new View(Graph.fromJSON(JSON.parse(JSON.stringify(graph))), set).files(), project(graph, set));
	});

	it("the base snapshot skips empty files and writes each file start gap", () => {
		const repo = Repo.init({ "b.txt": "b\n", "a.txt": "a\n", "empty.txt": "" });
		const a0 = repo.graph.atom("a0");
		assert.deepEqual(
			a0.inserts.map((r) => r.file),
			["a.txt", "b.txt"],
		);
		assert.deepEqual(a0.writes, [gapKey("^a.txt"), gapKey("^b.txt")]);
		assert.equal(repo.graph.lamport("a0"), 0);
	});
});

describe("explicit claims", () => {
	it("reliesOn holds lines anywhere and depends on their writers", () => {
		const repo = Repo.init({ "f.txt": FIVE, "g.txt": lines("g") });
		const g2 = repo.edit({ edits: [{ file: "g.txt", old: "g", new: "G" }] });
		const atom = repo.edit({
			edits: [{ file: "f.txt", old: "one", new: "ONE" }],
			reliesOn: [{ file: "g.txt", start: 0, end: 1 }],
		});
		assert.deepEqual(atom.holds, [lineKey(`${g2.id}.0`)]);
		assert.deepEqual(atom.deps, [g2.id]);
		assert.deepEqual(repo.graph.closureOf(atom.deps), repo.graph.closureOf(["a0", g2.id]));
	});

	it("reliesOn a range of lines also holds the gaps between them", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const atom = repo.draft({ reliesOn: [{ file: "f.txt", start: 1, end: 4 }] });
		assert.deepEqual(atom.holds, [gapKey("a0.1"), gapKey("a0.2"), lineKey("a0.1"), lineKey("a0.2"), lineKey("a0.3")]);
	});

	it("rejects empty or out-of-range ranges", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		assert.throws(() => repo.draft({ spans: [{ file: "f.txt", start: 2, end: 2 }] }), { code: "bad-range" });
		assert.throws(() => repo.draft({ reliesOn: [{ file: "f.txt", start: 4, end: 6 }] }), { code: "bad-range" });
		assert.throws(() => repo.draft({ reliesOn: [{ file: "nope.txt", start: 0, end: 1 }] }), { code: "bad-range" });
	});

	it("needs and resolves must be atoms in the view; reasons must point at real atoms", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const x = repo.edit({ edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
		assert.throws(() => repo.draft({ needs: ["a99"] }), { code: "unknown-atom" });
		assert.throws(() => repo.draft({ needs: [x.id] }, ["a0"]), { code: "not-in-view" });
		assert.throws(() => repo.draft({ resolves: [x.id] }, ["a0"]), { code: "not-in-view" });
		assert.throws(() => repo.draft({ reasons: [{ to: "a42", kind: "together", text: "" }] }), { code: "unknown-atom" });
		assert.throws(() => repo.draft({ reasons: [{ to: x.id, kind: "nope" as "together", text: "" }] }), {
			code: "bad-edit",
		});
		// An atom with only needs is allowed: it ties others together (a label head, say).
		const tie = repo.edit({ message: "feature", needs: [x.id] });
		assert.deepEqual(tie.deps, [x.id]);
		assert.deepEqual(repo.graph.atom(tie.id).inserts, []);
	});
});

describe("derived dependencies", () => {
	it("gap rule: an insertion depends on every atom whose lines hang off the same line, and on nothing below", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const added = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "two\nmid\n" }] });
		const removed = repo.edit({ edits: [{ file: "f.txt", old: "mid\n", new: "" }] });
		const three = repo.edit({ edits: [{ file: "f.txt", old: "three", new: "THREE" }] });
		// Inserting after "two": the gap holds mid (a tombstone hanging off "two") and then THREE.
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "two\nnew\n", mode: "after" }] });
		assert.deepEqual(atom.deps, [added.id]);
		assert.deepEqual(repo.graph.closureOf(atom.deps), repo.graph.closureOf(["a0", added.id]));
		assert.equal(repo.text("f.txt"), lines("one", "two", "new", "THREE", "four", "five"));
		// It outranks mid, so it sits directly after "two" in any set; in its own
		// closure mid is back (the deletion isn't in it) and stays below it.
		assert.equal(
			repo.text("f.txt", repo.graph.closure(atom.id)),
			lines("one", "two", "new", "mid", "three", "four", "five"),
		);
		assert.deepEqual(drop(repo.graph, repo.shared, removed.id).removed, [removed.id]);
		assert.deepEqual(drop(repo.graph, repo.shared, three.id).removed, [three.id]);
	});

	it("editing unrelated lines bottom-up gives the same independent atoms as top-down", () => {
		const SIX = lines("l1", "l2", "l3", "l4", "l5", "l6");
		const topDown = Repo.init({ "f.txt": SIX });
		const down = [1, 2, 3, 4, 5, 6].map((i) =>
			topDown.edit({ edits: [{ file: "f.txt", old: `l${i}`, new: `L${i}` }] }),
		);
		const bottomUp = Repo.init({ "f.txt": SIX });
		const up = [6, 5, 4, 3, 2, 1].map((i) => bottomUp.edit({ edits: [{ file: "f.txt", old: `l${i}`, new: `L${i}` }] }));
		assert.equal(bottomUp.text("f.txt"), topDown.text("f.txt"));
		assert.deepEqual(
			down.map((a) => a.deps),
			down.map(() => ["a0"]),
		);
		assert.deepEqual(
			up.map((a) => a.deps),
			up.map(() => ["a0"]),
		);
		// Dropping the edit to l6 leaves the edit to l5 (and the rest) alone.
		const { set, removed } = drop(bottomUp.graph, bottomUp.shared, up[0]!.id);
		assert.deepEqual(removed, [up[0]!.id]);
		assert.equal(bottomUp.text("f.txt", set), lines("L1", "L2", "L3", "L4", "L5", "l6"));
	});

	it("a live insert into a gap with an unresolved conflict depends on both sides of it", () => {
		// Kept on purpose (docs/prototype.md, "Dependencies"): without the gap
		// rule N would conflict with A on G:X, and live edits must not collide.
		const repo = Repo.init({ "f.txt": lines("X", "Y") });
		const A = repo.edit({ message: "A after X", edits: [{ file: "f.txt", old: "X\n", new: "X\nA\n" }] }, ["a0"]);
		const B = repo.edit({ message: "B after X", edits: [{ file: "f.txt", old: "X\n", new: "X\nB\n" }] }, ["a0"]);
		assert.equal(repo.text("f.txt"), lines("X", "B", "A", "Y"));
		const draft = repo.draft({ message: "N after X", edits: [{ file: "f.txt", start: 1, end: 1, lines: ["N"] }] });
		assert.deepEqual(repo.check(draft).conflicts, []);
		const N = repo.edit({ message: "N after X", edits: [{ file: "f.txt", start: 1, end: 1, lines: ["N"] }] });
		assert.deepEqual(N.deps, [A.id, B.id]);
		assert.deepEqual(repo.graph.closureOf(N.deps), repo.graph.closureOf(["a0", A.id, B.id]));
		assert.equal(repo.text("f.txt"), lines("X", "N", "B", "A", "Y"));
		assert.deepEqual(
			conflicts(repo.graph, repo.shared).map((c) => c.atoms),
			[[A.id, B.id]],
		);
		// Dropping a side takes N along; resolving the conflict keeps everything.
		assert.deepEqual(drop(repo.graph, repo.shared, A.id).removed, [A.id, N.id]);
		repo.edit({
			message: "keep both, A first",
			resolves: [A.id, B.id],
			edits: [{ file: "f.txt", old: "B\nA\n", new: "A\nB\n" }],
		});
		assert.equal(repo.text("f.txt"), lines("X", "N", "A", "B", "Y"));
	});

	it("implicit-read rule: changing a line someone inserted next to depends on that insert", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const between = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "two\nbetween\n" }] });
		assert.ok(between.reads.includes(lineKey("a0.2")));
		// Deleting "three" (the line below the insert) touches nothing the insert wrote,
		// but it changes a line the insert read: a sequential edit, so a dependency.
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "three\n", new: "" }] });
		assert.deepEqual(atom.deps, [between.id]);
		assert.deepEqual(repo.graph.closureOf(atom.deps), repo.graph.closureOf(["a0", between.id]));
		assert.deepEqual(
			checkDraft(repo.graph, repo.shared, repo.draft({ edits: [{ file: "f.txt", old: "four\n", new: "" }] })).conflicts,
			[],
		);
	});

	it("gap rule: claiming a gap someone inserted into (even if their lines are gone) depends on them", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const added = repo.edit({ edits: [{ file: "f.txt", old: "two\n", new: "two\nmid\n" }] });
		const removed = repo.edit({ edits: [{ file: "f.txt", old: "mid\n", new: "" }] });
		// A wide edit over two..three holds G:two, which `added` wrote.
		const draft = repo.draft({ edits: [{ file: "f.txt", old: "two\nthree\n", new: "two\nTHREE\n", mode: "wide" }] });
		assert.ok(draft.holds.includes(gapKey("a0.1")));
		assert.ok(draft.deps.includes(added.id));
		assert.ok(!draft.deps.includes(removed.id));
		assert.deepEqual(repo.check(draft).conflicts, []);
	});

	it("does not depend on the rest of its view", () => {
		const repo = Repo.init({ "f.txt": FIVE, "g.txt": lines("g") });
		repo.edit({ edits: [{ file: "g.txt", old: "g", new: "G" }] });
		repo.edit({ edits: [{ file: "f.txt", old: "five", new: "FIVE" }] });
		const atom = repo.edit({ edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
		assert.deepEqual(atom.deps, ["a0"]);
	});

	it("builds against any closed set, and refuses one that is not closed", () => {
		const repo = Repo.init({ "f.txt": FIVE });
		const x = repo.edit({ edits: [{ file: "f.txt", old: "one", new: "ONE" }] });
		const y = repo.edit({ edits: [{ file: "f.txt", old: "ONE", new: "uno" }] });
		assert.throws(() => new View(repo.graph, ["a0", y.id]), { code: "not-closed" });
		const old = repo.draft({ edits: [{ file: "f.txt", old: "one", new: "eins" }] }, ["a0"]);
		assert.deepEqual(old.deps, ["a0"]);
		assert.ok(!old.deps.includes(x.id));
	});
});
