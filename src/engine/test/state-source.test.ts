import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDraft, Graph, View } from "../index.ts";
import { CachedStateStorage, storedLists, storedNumbers } from "../state-source.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("per-file list pages append and reopen without reading the full historical list", () => {
	const source = new SqlState();
	try {
		const storage = new CachedStateStorage(source);
		const lists = storedLists<string>(storage, "files");
		for (let i = 0; i < 1025; i++) storage.transaction(() => lists.append("a.txt", `a${i}`));
		assert.equal(lists.length("a.txt"), 1025);
		assert.deepEqual([...lists.keys()], ["a.txt"]);
		storage.clear();
		const before = source.reads;
		storage.transaction(() => lists.append("a.txt", "a1025"));
		assert.ok(source.reads - before <= 2, "append reads only one page and its length");
		assert.throws(
			() =>
				storage.transaction(() => {
					lists.append("a.txt", "rolled-back");
					throw new Error("rollback");
				}),
			/rollback/,
		);
		const reopened = storedLists<string>(new CachedStateStorage(source), "files");
		assert.deepEqual(
			[...reopened.values("a.txt")],
			Array.from({ length: 1026 }, (_, i) => `a${i}`),
		);
		for (const [, page] of source.entries("files:pages")) assert.ok((page as string[]).length <= 256);
		source.write("legacy", "a.txt", ["a0"]);
		assert.throws(() => [...storedLists(source, "legacy").keys()], /canonical-log adoption/);
	} finally {
		source.db.close();
	}
});

test("numeric pages cross boundaries, reopen, mutate and roll back without retaining history", () => {
	const source = new SqlState();
	const storage = new CachedStateStorage(source);
	const numbers = storedNumbers(storage, "numbers");
	storage.transaction(() => {
		for (let i = 0; i < 1025; i++) numbers.push(i - 1);
	});
	storage.clear();
	const reads = source.reads;
	for (let i = 0; i < 1025; i++) assert.equal(numbers.at(i), i - 1);
	assert.ok(source.reads - reads <= 7, "one backing read per page plus metadata");
	assert.equal([...source.entries("numbers:pages")].length, 5);
	assert.throws(
		() =>
			storage.transaction(() => {
				numbers.set(255, -99);
				numbers.set(256, -98);
				numbers.push(1025);
				throw new Error("rollback");
			}),
		/rollback/,
	);
	const reopened = storedNumbers(new CachedStateStorage(source), "numbers");
	assert.equal(reopened.length, 1025);
	assert.equal(reopened.at(255), 254);
	assert.equal(reopened.at(256), 255);
	assert.equal(numbers.at(255), 254);
	reopened.set(256, -42);
	assert.equal(reopened.at(256), -42);
	assert.throws(() => reopened.at(1025), /out of bounds/);
	assert.throws(() => reopened.set(-1, 2), /out of bounds/);
	assert.throws(() => reopened.push(NaN), /safe integers/);
});

test("numeric pages reject legacy or missing pages instead of fabricating values", () => {
	const storage = new SqlState();
	storage.write("legacy:meta", "length", 256);
	const legacy = storedNumbers(storage, "legacy");
	assert.throws(() => legacy.at(0), /canonical-log adoption/);
	assert.throws(() => legacy.push(1), /canonical-log adoption/);
	const numbers = storedNumbers(storage, "new");
	numbers.push(5);
	storage.remove("new:pages", "0");
	assert.throws(() => numbers.at(0), /missing writer numeric page/);
});

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
