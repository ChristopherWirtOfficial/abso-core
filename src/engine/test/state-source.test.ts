import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDraft, Graph, View } from "../index.ts";
import { CachedStateStorage, StableOverlaySet, storedLists, storedNumbers } from "../state-source.ts";
import { lines, Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("current visibility stops at the first included deletion while history retains every deleter", () => {
	class ObservedStorage extends SqlState {
		pageReads = 0;
		override read(collection: string, key: string): unknown {
			if (collection === "more-deleters:pages") this.pageReads++;
			return super.read(collection, key);
		}
	}
	const storage = new ObservedStorage();
	try {
		const oracle = Repo.init({ "a.txt": "gone\nlive\n" });
		const deletion = oracle.draft({ edits: [{ file: "a.txt", old: "gone\n", new: "" }] });
		const graph = new Graph({ storage });
		graph.add(oracle.graph.atom("a0"));
		const ids = ["a0"];
		for (let seq = 1; seq <= 514; seq++) {
			const atom = { ...deletion, id: `a${seq}`, seq };
			graph.add(atom);
			oracle.graph.add(atom);
			ids.push(atom.id);
		}
		const reopened = new Graph({ storage });
		const membership = new StableOverlaySet(ids);
		const view = new View(reopened, membership);
		storage.pageReads = 0;
		assert.equal(view.text("a.txt"), "live\n");
		assert.equal(storage.pageReads, 0, "current visibility needs no later deleters after the first match");
		assert.deepEqual(view.sequence("a.txt"), new View(oracle.graph, membership).sequence("a.txt"));
		assert.equal(view.sequence("a.txt")[0]!.deletedBy.length, 514);
		assert.equal(storage.pageReads, 3);
		assert.deepEqual(reopened.deletersOf("a0.0"), oracle.graph.deletersOf("a0.0"));
		const lastOnly = new View(reopened, new StableOverlaySet(["a0", "a514"]));
		assert.equal(lastOnly.text("a.txt"), "live\n", "excluded early deletions must not hide a later included one");
	} finally {
		storage.db.close();
	}
});

test("relocation indexes stream one fixed page before yielding and preserve order", () => {
	class ObservedStorage extends SqlState {
		pageReads = 0;
		largestPage = 0;
		override read(collection: string, key: string): unknown {
			if (collection.startsWith("relocat") && collection.endsWith(":pages")) this.pageReads++;
			return super.read(collection, key);
		}
		override write(collection: string, key: string, value: unknown): void {
			if (collection.startsWith("relocat") && collection.endsWith(":pages")) {
				assert.ok(Array.isArray(value));
				this.largestPage = Math.max(this.largestPage, value.length);
			}
			super.write(collection, key, value);
		}
	}
	const storage = new ObservedStorage();
	try {
		const oracle = Repo.init({ "a.txt": "one\n", "b.txt": "" });
		const move = oracle.draft({ move: { file: "a.txt", start: 0, end: 1, to: "b.txt", at: 0 } });
		const graph = new Graph({ storage });
		graph.add(oracle.graph.atom("a0"));
		for (let seq = 1; seq <= 513; seq++) {
			const atom = { ...move, id: `a${seq}`, seq };
			graph.add(atom);
			oracle.graph.add(atom);
		}
		const reopened = new Graph({ storage });
		storage.pageReads = 0;
		const iterator = reopened.eachRelocationOf("a0.0");
		assert.deepEqual(iterator.next().value, oracle.graph.relocationsOf("a0.0")[0]);
		assert.equal(storage.pageReads, 1, "first result must decode only one page");
		assert.deepEqual(reopened.relocationsOf("a0.0"), oracle.graph.relocationsOf("a0.0"));
		const parent = move.moves![0]!.parent;
		const code = reopened.codeOf(parent)!;
		assert.deepEqual(reopened.relocatedTo(parent), oracle.graph.relocatedTo(parent));
		assert.deepEqual([...reopened.eachRelocatedToCode(code)], oracle.graph.relocatedToCode(code));
		assert.equal(storage.largestPage, 256);
	} finally {
		storage.db.close();
	}
});

test("hot claim indexes stream bounded pages after reopening", (t) => {
	const oracle = Repo.init({ "a.txt": lines("one", "two") });
	const draft = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "ONE" }] });
	const source = new SqlState();
	try {
		const graph = new Graph({ storage: source });
		graph.add(oracle.graph.atom("a0"));
		for (let i = 0; i < 513; i++) {
			const atom = { ...draft, id: `a${i + 1}`, seq: i + 1 };
			graph.add(atom);
			oracle.graph.add(atom);
		}
		const reopened = new Graph({ storage: source });
		const read = source.read.bind(source);
		let pagesRead = 0;
		t.mock.method(source, "read", (collection: string, key: string) => {
			if (collection === "writers:pages") pagesRead++;
			return read(collection, key);
		});
		const iterator = reopened.eachWriterOf("L:a0.0");
		assert.equal(iterator.next().value, "a1");
		assert.equal(pagesRead, 1, "first claimant reads one claim page, not the entire hot-key history");
		assert.deepEqual(reopened.writersOf("L:a0.0"), oracle.graph.writersOf("L:a0.0"));
		assert.deepEqual([...reopened.eachDependentOf("a0")], oracle.graph.dependentsOf("a0"));
		for (const name of ["writers", "readers", "holders", "dependents", "resolvers"]) {
			assert.equal([...source.entries(name)].length, 0, "no whole-list claim rows remain");
			for (const [, page] of source.entries(`${name}:pages`)) assert.ok((page as string[]).length <= 256);
		}
		const key = JSON.stringify(["number", 0]);
		source.write("legacy-claims", key, ["old"]);
		assert.throws(
			() => [...storedLists(source, "legacy-claims", (value) => value).values(key)],
			/canonical-log adoption/,
		);
	} finally {
		source.db.close();
	}
});

test("stable views stream movers instead of allocating a filtered history array", (t) => {
	const oracle = Repo.init({ "a.txt": lines("one", "two"), "b.txt": "" });
	oracle.edit({ move: { file: "a.txt", start: 0, end: 1, to: "b.txt", at: 0 } });
	const expected = oracle.files();
	const movers = oracle.graph.movers();
	t.mock.method(
		oracle.graph,
		"movers",
		() =>
			new Proxy(movers, {
				get(target, key, receiver) {
					if (key === "filter") throw new Error("whole mover history copied");
					return Reflect.get(target, key, receiver);
				},
			}),
	);
	const view = new View(oracle.graph, new StableOverlaySet(oracle.shared));
	assert.equal(view.hasMoves(), true);
	assert.deepEqual(view.files(), expected);
});

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

test("together links stream bounded pages in both directions after storage reopen", () => {
	class ObservedStorage extends SqlState {
		pageReads = 0;
		largestPage = 0;
		override read(collection: string, key: string): unknown {
			if (collection === "together:pages") this.pageReads++;
			return super.read(collection, key);
		}
		override write(collection: string, key: string, value: unknown): void {
			if (collection === "together:pages") {
				assert.ok(Array.isArray(value));
				this.largestPage = Math.max(this.largestPage, value.length);
			}
			super.write(collection, key, value);
		}
	}
	const storage = new ObservedStorage();
	try {
		const oracle = Repo.init({ "a.txt": "one\n" });
		const draft = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "ONE" }] });
		const graph = new Graph({ storage });
		graph.add(oracle.graph.atom("a0"));
		for (let seq = 1; seq <= 513; seq++) {
			const atom = {
				...draft,
				id: `a${seq}`,
				seq,
				reasons: [{ to: "a0", kind: "together" as const, text: `reason ${seq}` }],
			};
			graph.add(atom);
			oracle.graph.add(atom);
		}
		const reopened = new Graph({ storage });
		storage.pageReads = 0;
		const iterator = reopened.eachTogetherLink("a0");
		assert.deepEqual(iterator.next().value, oracle.graph.togetherLinks("a0")[0]);
		assert.equal(storage.pageReads, 1);
		storage.pageReads = 0;
		assert.deepEqual(reopened.togetherLinks("a0"), oracle.graph.togetherLinks("a0"));
		assert.equal(storage.pageReads, 3);
		assert.deepEqual(reopened.togetherLinks("a513"), oracle.graph.togetherLinks("a513"));
		assert.equal(storage.largestPage, 256);
	} finally {
		storage.db.close();
	}
});

test("child indexes stream bounded pages before filtering historical siblings", () => {
	class ObservedStorage extends SqlState {
		pageReads = 0;
		largestPage = 0;
		override read(collection: string, key: string): unknown {
			if (collection === "run-starts:pages") this.pageReads++;
			return super.read(collection, key);
		}
		override write(collection: string, key: string, value: unknown): void {
			if (collection === "run-starts:pages") {
				assert.ok(Array.isArray(value));
				this.largestPage = Math.max(this.largestPage, value.length);
			}
			super.write(collection, key, value);
		}
	}
	const storage = new ObservedStorage();
	try {
		const oracle = Repo.init({ "a.txt": "one\ntwo\n" });
		const draft = oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "ONE" }] });
		const graph = new Graph({ storage });
		graph.add(oracle.graph.atom("a0"));
		for (let seq = 1; seq <= 513; seq++) {
			const atom = { ...draft, id: `a${seq}`, seq };
			graph.add(atom);
			oracle.graph.add(atom);
		}
		const reopened = new Graph({ storage });
		const parent = draft.inserts[0]!.parent;
		const code = reopened.codeOf(parent)!;
		storage.pageReads = 0;
		const iterator = reopened.eachChildN(code);
		const first = iterator.next().value!;
		assert.equal(first, reopened.lineN(oracle.graph.childrenOf(parent)[0]!));
		assert.ok(storage.pageReads <= 1);
		if (storage.pageReads === 0) {
			iterator.next();
			assert.equal(storage.pageReads, 1, "the implicit child needs no page; the next sibling needs one");
		}
		assert.deepEqual(reopened.childrenOf(parent), oracle.graph.childrenOf(parent));
		assert.deepEqual(
			reopened.childrenOf("a0.0"),
			oracle.graph.childrenOf("a0.0"),
			"implicit same-run child order is retained",
		);
		assert.equal(storage.largestPage, 256);
		const membership = new StableOverlaySet(["a0"]);
		assert.equal(new View(reopened, membership).text("a.txt"), "one\ntwo\n");
		assert.deepEqual(
			new View(reopened, membership).sequence("a.txt"),
			new View(oracle.graph, membership).sequence("a.txt"),
		);
	} finally {
		storage.db.close();
	}
});

test("persistent layout uses ordered successors without retaining deep or wide history frontiers", () => {
	for (const shape of ["deep", "wide"] as const) {
		const storage = new SqlState();
		try {
			const oracle = Repo.init({
				"a.txt": shape === "deep" ? Array.from({ length: 1024 }, (_, n) => `line ${n}\n`).join("") : "base\n",
			});
			if (shape === "wide") {
				const draft = oracle.draft({ edits: [{ file: "a.txt", old: "base", new: "branch" }] });
				for (let seq = 1; seq <= 256; seq++) {
					const atom = { ...draft, id: `a${seq}`, seq };
					oracle.graph.add(atom);
					oracle.shared.add(atom.id);
				}
			}
			const before = oracle.view().text("a.txt");
			oracle.edit({ edits: [{ file: "a.txt", old: before, new: "live\n" }] });
			const graph = new Graph({ storage });
			for (const id of oracle.shared) graph.add(oracle.graph.atom(id));
			const reopened = new Graph({ storage });
			reopened.eachChildN = () => {
				throw Error("unordered child collection forbidden");
			};
			reopened.childrenN = () => {
				throw Error("materialized child collection forbidden");
			};
			const original = reopened.orderedChildrenN.bind(reopened);
			let active = 0,
				maximum = 0;
			reopened.orderedChildrenN = function* (parent: number, after?: number) {
				active++;
				maximum = Math.max(maximum, active);
				try {
					yield* original(parent, after);
				} finally {
					active--;
				}
			};
			const view = new View(reopened, new StableOverlaySet(oracle.shared));
			assert.equal(view.text("a.txt"), "live\n");
			assert.equal(active, 0);
			assert.equal(maximum, 1, "no ordered iterator retained per historical ancestor");
			assert.deepEqual(view.sequence("a.txt"), oracle.view().sequence("a.txt"));
		} finally {
			storage.db.close();
		}
	}
});

test("ordered layout refuses missing format or child metadata instead of dropping history", () => {
	const storage = new SqlState();
	try {
		const oracle = Repo.init({ "a.txt": "one\n" });
		const graph = new Graph({ storage });
		graph.add(oracle.graph.atom("a0"));
		storage.remove("ordered-children", "format");
		assert.throws(() => new View(new Graph({ storage }), new StableOverlaySet(["a0"])).text("a.txt"), /fresh adoption/);
		assert.throws(
			() => new Graph({ storage }).add(oracle.draft({ edits: [{ file: "a.txt", old: "one", new: "two" }] })),
			/fresh adoption/,
		);
		storage.write("ordered-children", "format", 1);
		const parent = graph.startCodeOf("a.txt")!;
		storage.remove("ordered-children", JSON.stringify([String(parent), "meta"]));
		assert.throws(() => [...graph.orderedChildrenN(parent)], /missing ordered index metadata/);
	} finally {
		storage.db.close();
	}
});
