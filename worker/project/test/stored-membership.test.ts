import assert from "node:assert/strict";
import { test } from "node:test";
import { StoredMap, StoredSet } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import { Membership } from "../spaces.ts";

test("key-only scans do not decode or retain values through overridden entry iterators", () => {
	const storage = new SqlState();
	const seed = new StoredMap<string, number>(storage, "keys-only");
	seed.set("old", 1).set("kept", 2);
	seed.delete("old");
	seed.set("old", 3);
	class ValuesForbidden extends StoredMap<string, number> {
		override entries(): MapIterator<[string, number]> {
			throw new Error("key scans must not invoke retaining value iterators");
		}
	}
	const map = new ValuesForbidden(storage, "keys-only", {
		encode: (value) => value,
		decode: () => {
			throw new Error("value decoding forbidden");
		},
	});
	assert.deepEqual([...map.keys()], ["kept", "old"]);
	map.clear();
	assert.equal(map.size, 0);
	storage.db.close();
});

test("persistent collections preserve insertion order, deletion, reinsert and undefined values", () => {
	const storage = new SqlState();
	const map = new StoredMap<string, number | undefined>(storage, "map");
	map.set("z", 1).set("a", undefined).set("m", 3);
	map.delete("z");
	map.set("z", 4);
	const reopened = new StoredMap<string, number | undefined>(storage, "map");
	assert.equal(reopened.size, 3);
	assert.equal(reopened.has("a"), true);
	assert.deepEqual(
		[...reopened],
		[
			["a", undefined],
			["m", 3],
			["z", 4],
		],
	);
	const set = new StoredSet<string>(storage, "set");
	set.add("z").add("a").add("z");
	assert.deepEqual([...new StoredSet<string>(storage, "set")], ["z", "a"]);
	storage.db.close();
});

test("membership reopens stored versions and preserves historical drop and amendment semantics", () => {
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "one\ntwo\n" }, 0);
	project.record("writer", { "a.txt": "ONE\ntwo\n" }, 1);
	assert.equal(project.publish("writer", "First edit", 2).ok, true);
	project.drop("writer", [1], "Undo", 3);
	const oracle = new Membership();
	const storage = new SqlState();
	const stored = new Membership(storage);
	for (const [at, entry] of log.entries.entries()) {
		oracle.apply(entry, at);
		stored.apply(entry, at);
	}
	const reads = storage.reads;
	const reopened = new Membership(storage);
	assert.equal(storage.reads - reads, 1, "reopen only checks the space directory; it does not read version history");
	assert.equal(storage.scans, 0);
	assert.deepEqual([...reopened.shared.versions], oracle.shared.versions);
	assert.deepEqual([...reopened.shared.own], [...oracle.shared.own]);
	assert.deepEqual([...reopened.shared.publishedIn], [...oracle.shared.publishedIn]);
	assert.deepEqual([...reopened.shared.droppedIn], [...oracle.shared.droppedIn]);
	for (let version = 0; version < oracle.shared.versions.length; version++) {
		assert.deepEqual([...reopened.at(reopened.shared, version)], [...oracle.at(oracle.shared, version)]);
	}
	const amend = { type: "amend" as const, agent: "writer", version: 1, message: "Corrected", time: 4 };
	reopened.apply(amend, log.entries.length);
	const again = new Membership(storage);
	assert.equal(again.shared.versions[1]?.message, "Corrected");
	assert.equal(again.shared.versions[1]?.originalMessage, "First edit");
	storage.db.close();
});

test("membership application rolls back its version and every index together", () => {
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "one\n" }, 0);
	const storage = new SqlState();
	const membership = new Membership(storage);
	storage.failWrite = storage.writes + 5;
	assert.throws(() => membership.apply(log.entries[0]!, 0), /injected storage failure/);
	const reopened = new Membership(storage);
	assert.equal(reopened.shared.versions.length, 0);
	assert.equal(reopened.shared.own.size, 0);
	assert.equal(reopened.shared.publishedIn.size, 0);
	storage.failWrite = Infinity;
	reopened.apply(log.entries[0]!, 0);
	assert.equal(new Membership(storage).shared.versions.length, 1);
	storage.db.close();
});

test("stored membership preserves named draft bases and land across reopen", () => {
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "one\n" }, 0);
	project.switchTo("writer", "branch", 1);
	project.record("writer", { "a.txt": "ONE\n" }, 2);
	assert.equal(project.publish("writer", "Branch edit", 3).ok, true);
	assert.equal(project.land("writer", "Land", 4).ok, true);
	const storage = new SqlState();
	const oracle = new Membership();
	const stored = new Membership(storage);
	for (const [at, entry] of log.entries.entries()) {
		oracle.apply(entry, at);
		stored.apply(entry, at);
	}
	const reopened = new Membership(storage);
	for (const [name, space] of oracle.spaces) {
		const actual = reopened.spaces.get(name)!;
		assert.equal(actual.startedAt, space.startedAt);
		assert.deepEqual([...actual.versions], space.versions);
		for (let version = 0; version < space.versions.length; version++)
			assert.deepEqual([...reopened.at(actual, version)], [...oracle.at(space, version)]);
	}
	storage.db.close();
});

test("opening an old shared membership does not hydrate its atom set", () => {
	const log = new MemoryStore();
	const project = new Project(log);
	project.init({ "a.txt": "zero\n" }, 0);
	for (let i = 1; i <= 40; i++) {
		project.record("writer", { "a.txt": `${i}\n` }, i * 2);
		assert.equal(project.publish("writer", `Edit ${i}`, i * 2 + 1).ok, true);
	}
	const storage = new SqlState();
	const membership = new Membership(storage);
	for (const [at, entry] of log.entries.entries()) membership.apply(entry, at);
	const reopened = new Membership(storage);
	const shared = reopened.shared;
	const reads = storage.reads;
	const old = reopened.at(shared, 20);
	// One read: whether shared's closure is kept on disk (abso Capacity). Nothing of the history.
	assert.equal(storage.reads - reads, 1, "opening a historical membership does not read historical state");
	assert.equal(old.size, 41);
	assert.equal(old.has("a0"), true);
	assert.equal(old.has("a79"), false);
	assert.equal(reopened.setsKept, 0, "storage-backed shared history never fills the in-memory set cache");
	storage.db.close();
});
