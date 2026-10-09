// Conflicts, resolution, draft reports.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkDraft,
	claimsOf,
	conflicts,
	gapKey,
	independent,
	keyOverlap,
	lineKey,
	touchesOf,
	unresolvedConflicts,
} from "../index.ts";
import { lines, Repo } from "./helpers.ts";

const FILE = lines("one", "two", "three", "four");

describe("keyOverlap", () => {
	it("counts writes against claims only; read-read and hold-hold never count", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const readA = repo.edit({ edits: [{ file: "f.txt", start: 1, end: 1, lines: ["x"], mode: "after" }] }, ["a0"]);
		const readB = repo.edit(
			{ edits: [{ file: "f.txt", start: 4, end: 4, lines: ["y"] }], reliesOn: [{ file: "f.txt", start: 0, end: 1 }] },
			["a0"],
		);
		const holdC = repo.edit({ spans: [{ file: "f.txt", start: 0, end: 2 }] }, ["a0"]);
		assert.deepEqual(keyOverlap(repo.graph.atom(readA.id), repo.graph.atom(readB.id)), []); // both read/hold "one"
		assert.deepEqual(keyOverlap(readB, holdC), []); // both hold "one"
		// readA writes G:one, which holdC holds (the gap between one and two).
		assert.deepEqual(keyOverlap(readA, holdC), [
			{ key: gapKey("a0.0"), writer: readA.id, other: holdC.id, relation: "hold" },
		]);
		assert.deepEqual(claimsOf(readA), [gapKey("a0.0"), lineKey("a0.0")]);
	});
});

describe("conflicts in a set", () => {
	it("edits only: an atom that depends on the other never conflicts with it", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const a = repo.edit({ edits: [{ file: "f.txt", old: "two", new: "TWO" }] });
		const b = repo.edit({ edits: [{ file: "f.txt", old: "TWO", new: "2" }] });
		assert.equal(independent(repo.graph, a.id, b.id), false);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
	});

	it("a hold is released only by naming the holder, not by a derived dependency", () => {
		const repo = Repo.init({ "f.txt": FILE });
		// A wide insert between two and three holds both lines and reads three.
		const wide = repo.edit({
			author: "ann",
			message: "this stack is mine",
			edits: [{ file: "f.txt", old: "two\nthree\n", new: "two\nmid\nthree\n", mode: "wide" }],
		});
		assert.ok(wide.holds.includes(lineKey("a0.2")));
		// Deleting three depends on the wide atom (it read three), but writes into its hold.
		const del = { edits: [{ file: "f.txt", old: "three\n", new: "" }] };
		const draft = repo.draft(del);
		assert.ok(draft.deps.includes(wide.id));
		assert.deepEqual(
			repo.check(draft).conflicts.map((c) => [c.atoms, c.kind, c.keys]),
			[
				[
					[wide.id, draft.id],
					"semantic",
					[{ key: lineKey("a0.2"), writer: draft.id, other: wide.id, relation: "hold" }],
				],
			],
		);
		// Naming the holder releases it.
		assert.deepEqual(repo.check(repo.draft({ ...del, needs: [wide.id] })).conflicts, []);
		// Accepted without naming it (--allow-conflict), the set reports the same conflict.
		const accepted = repo.edit(del);
		assert.deepEqual(
			conflicts(repo.graph, repo.shared).map((c) => [c.atoms, c.kind]),
			[[[wide.id, accepted.id], "semantic"]],
		);
		// A resolution settles it.
		repo.edit({ message: "fine by ann", resolves: [wide.id, accepted.id] });
		assert.deepEqual(unresolvedConflicts(repo.graph, repo.shared), []);
	});

	it("checkDraft and conflicts name the same writer for a key both sides write", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const a = repo.edit({ edits: [{ file: "f.txt", old: "two", new: "TWO" }] }, ["a0"]);
		const draft = repo.draft({ edits: [{ file: "f.txt", old: "two", new: "2" }] }, ["a0"]);
		const reported = repo.check(draft).conflicts;
		repo.edit({ edits: [{ file: "f.txt", old: "two", new: "2" }] }, ["a0"]);
		const stored = conflicts(repo.graph, repo.shared);
		assert.deepEqual(
			reported.map((c) => c.keys),
			stored.map((c) => c.keys),
		);
		assert.deepEqual(stored[0]!.keys, [{ key: lineKey("a0.1"), writer: a.id, other: draft.id, relation: "write" }]);
	});

	it("is resolved only by an atom that names both sides", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const a = repo.edit({ message: "two is TWO", edits: [{ file: "f.txt", old: "two", new: "TWO" }] }, ["a0"]);
		const b = repo.edit({ message: "two is 2", edits: [{ file: "f.txt", old: "two", new: "2" }] }, ["a0"]);
		const c = repo.edit({ message: "three is 3", edits: [{ file: "f.txt", old: "three\n", new: "3\n" }] }, ["a0"]);
		const d = repo.edit({ message: "three is III", edits: [{ file: "f.txt", old: "three", new: "III" }] }, ["a0"]);
		assert.deepEqual(
			conflicts(repo.graph, repo.shared).map((x) => x.atoms),
			[
				[a.id, b.id],
				[c.id, d.id],
			],
		);

		const half = repo.edit({ message: "keep TWO", resolves: [a.id] });
		assert.equal(unresolvedConflicts(repo.graph, repo.shared).length, 2);
		const both = repo.edit({ message: "TWO wins over 2", resolves: [a.id, b.id] });
		const after = conflicts(repo.graph, repo.shared);
		assert.deepEqual(
			after.map((x) => [x.atoms, x.resolvedBy]),
			[
				[[a.id, b.id], [both.id]],
				[[c.id, d.id], []],
			],
		);
		assert.deepEqual(
			unresolvedConflicts(repo.graph, repo.shared).map((x) => x.atoms),
			[[c.id, d.id]],
		);
		// A resolution outside the set doesn't count.
		const without = new Set([...repo.shared].filter((id) => id !== both.id));
		assert.equal(unresolvedConflicts(repo.graph, without).length, 2);
		void half;
	});

	it("a conflicted set still projects, priority breaking the tie", () => {
		const repo = Repo.init({ "f.txt": FILE });
		repo.edit({ edits: [{ file: "f.txt", old: "two", new: "TWO" }] }, ["a0"]);
		repo.edit({ edits: [{ file: "f.txt", old: "two", new: "2" }] }, ["a0"]);
		// Both replaced "two": both runs hang off it, the higher seq first.
		assert.equal(repo.text("f.txt"), lines("one", "2", "TWO", "three", "four"));
	});

	it("kind: edit-edit when any overlap is textual, semantic when every overlap is against a hold", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const holder = repo.edit(
			{ edits: [{ file: "f.txt", old: "one", new: "ONE" }], reliesOn: [{ file: "f.txt", start: 2, end: 3 }] },
			["a0"],
		);
		const writer = repo.edit({ edits: [{ file: "f.txt", old: "three", new: "THREE" }] }, ["a0"]);
		const both = repo.edit({ edits: [{ file: "f.txt", old: "one\ntwo\nthree", new: "1\n2\n3" }] }, ["a0"]);
		const found = conflicts(repo.graph, repo.shared);
		const kindOf = (x: string, y: string) => found.find((c) => c.atoms[0] === x && c.atoms[1] === y)?.kind;
		assert.equal(kindOf(holder.id, writer.id), "semantic");
		assert.equal(kindOf(holder.id, both.id), "edit-edit");
		assert.equal(kindOf(writer.id, both.id), "edit-edit");
	});
});

describe("checkDraft", () => {
	it("reports whose lines a draft writes, reads and holds, with author and message", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const ann = repo.edit({ author: "ann", message: "two is TWO", edits: [{ file: "f.txt", old: "two", new: "TWO" }] });
		const draft = repo.draft({
			edits: [{ file: "f.txt", old: "TWO\nthree\n", new: "TWO\nnew\nthree\n" }],
			reliesOn: [{ file: "f.txt", start: 3, end: 4 }],
		});
		assert.deepEqual(touchesOf(repo.graph, draft), [
			{ atom: "a0", author: "import", message: "starting snapshot", writes: [], reads: ["a0.2"], holds: ["a0.3"] },
			{ atom: ann.id, author: "ann", message: "two is TWO", writes: [], reads: [`${ann.id}.0`], holds: [] },
		]);
		const report = checkDraft(repo.graph, repo.shared, draft);
		assert.deepEqual(report.conflicts, []);
		assert.deepEqual(report.warnings, []);
		assert.equal(report.touches.length, 2);
	});

	it("reports conflicts with independent atoms only, never resolved", () => {
		const repo = Repo.init({ "f.txt": FILE });
		const claim = repo.edit({ author: "ann", message: "mine", spans: [{ file: "f.txt", start: 1, end: 3 }] });
		const draft = repo.draft({ edits: [{ file: "f.txt", old: "three", new: "THREE" }] });
		const report = checkDraft(repo.graph, repo.shared, draft);
		assert.equal(report.conflicts.length, 1);
		assert.deepEqual(report.conflicts[0]!.atoms, [claim.id, draft.id]);
		assert.deepEqual(report.conflicts[0]!.resolvedBy, []);
		assert.deepEqual(report.conflicts[0]!.keys, [
			{ key: lineKey("a0.2"), writer: draft.id, other: claim.id, relation: "hold" },
		]);
		// Checked against a set without the claim, nothing collides.
		assert.deepEqual(checkDraft(repo.graph, new Set(["a0"]), draft).conflicts, []);
	});
});
