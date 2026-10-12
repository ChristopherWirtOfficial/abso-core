import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDraft, Graph, View } from "../index.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("stored graph reopens without replay and preserves moves, conflicts and new edits", () => {
	const oracle = Repo.init({ "a.txt": lines("one", "two", "three"), "b.txt": "" });
	oracle.edit({ edits: [{ file: "a.txt", old: "two", new: "TWO" }] });
	oracle.edit({ move: { file: "a.txt", start: 1, end: 2, to: "b.txt", at: 0 } });
	const storage = new SqlState();
	const original = new Graph({ storage });
	for (const atom of oracle.graph.atoms()) original.add(atom);
	original.setLabel({ name: "saved", head: "a2", title: "Saved", message: "" });
	const reads = storage.reads;
	const reopened = new Graph({ storage });
	assert.equal(storage.reads, reads, "opening does not hydrate historical collections");
	assert.equal(storage.scans, 0);
	assert.equal(reopened.size, oracle.graph.size);
	assert.equal(reopened.lineCount, oracle.graph.lineCount);
	assert.deepEqual([...reopened.movers()], [...oracle.graph.movers()]);
	for (const atom of oracle.graph.atoms()) {
		assert.deepEqual(reopened.filesOf(atom.id), oracle.graph.filesOf(atom.id));
		for (const move of atom.moves ?? []) {
			assert.deepEqual(reopened.relocationsOf(move.line), oracle.graph.relocationsOf(move.line));
			assert.deepEqual(reopened.relocatedTo(move.parent), oracle.graph.relocatedTo(move.parent));
			assert.equal(reopened.codeOf(move.parent), oracle.graph.codeOf(move.parent));
		}
	}
	assert.deepEqual(new View(reopened, oracle.shared).files(), oracle.files());
	assert.equal(reopened.label("saved")?.head, "a2");
	const draft = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "ONE" }] });
	assert.deepEqual(checkDraft(reopened, oracle.shared, draft), oracle.check(draft));
	oracle.graph.add(draft);
	reopened.add(draft);
	oracle.shared.add(draft.id);
	assert.deepEqual(new View(new Graph({ storage }), oracle.shared).files(), oracle.files());
	for (let n = 0; n < oracle.graph.lineCount; n++) {
		const id = oracle.graph.lineIdOf(n);
		assert.deepEqual(reopened.line(id), oracle.graph.line(id));
		assert.deepEqual(reopened.deletersOf(id), oracle.graph.deletersOf(id));
	}
	assert.ok(Object.isFrozen(reopened.atom("a0")));
	storage.db.close();
});

test("stored indexes retain multiple claimants and preserve a real divergent conflict", () => {
	const oracle = Repo.init({ "a.txt": lines("one", "two", "three") });
	oracle.edit({ edits: [{ file: "a.txt", old: "one", new: "ONE" }], author: "left" });
	const right = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "uno" }], author: "right" }, ["a0"]);
	const storage = new SqlState();
	const graph = new Graph({ storage });
	for (const atom of oracle.graph.atoms()) graph.add(atom);
	assert.equal(oracle.check(right).conflicts.length, 1);
	assert.deepEqual(checkDraft(new Graph({ storage }), oracle.shared, right), oracle.check(right));
	graph.add(right);
	oracle.graph.add(right);
	assert.deepEqual(new Graph({ storage }).writersOf("L:a0.0"), oracle.graph.writersOf("L:a0.0"));
	assert.deepEqual(new Graph({ storage }).deletedLines(right.id), oracle.graph.deletedLines(right.id));
	storage.db.close();
});

test("failed stored append rolls back all graph indexes and can be retried", () => {
	const oracle = Repo.init({ "a.txt": lines("one", "two") });
	const storage = new SqlState();
	const graph = new Graph({ storage });
	graph.add(oracle.graph.atom("a0"));
	const before = JSON.stringify(graph.toJSON());
	const draft = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "ONE" }] });
	storage.failWrite = storage.writes + 10;
	assert.throws(() => graph.add(draft), /injected storage failure/);
	assert.equal(JSON.stringify(graph.toJSON()), before);
	assert.equal(JSON.stringify(new Graph({ storage }).toJSON()), before);
	storage.failWrite = Infinity;
	graph.add(draft);
	assert.equal(new Graph({ storage }).size, 2);
	storage.db.close();
});

test("removing a stored label rolls back dependent rewrites on failure", () => {
	const oracle = Repo.init({ "a.txt": lines("one") });
	const storage = new SqlState();
	const graph = new Graph({ storage });
	graph.add(oracle.graph.atom("a0"));
	graph.setLabel({ name: "base", head: "a0", title: "Base", message: "" });
	graph.setLabel({ name: "child", head: "a0", base: "base", title: "Child", message: "" });
	const before = graph.labels();
	storage.failWrite = storage.writes + 1;
	assert.throws(() => graph.removeLabel("base"), /injected storage failure/);
	assert.deepEqual(new Graph({ storage }).labels(), before);
	storage.failWrite = Infinity;
	assert.equal(graph.removeLabel("base"), true);
	assert.equal(new Graph({ storage }).label("base"), undefined);
	assert.equal(new Graph({ storage }).label("child")?.base, "a0");
	storage.db.close();
});
