import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GitPackResolver } from "../src/git-pack-resolver.ts";
import { memoryStorage } from "./helpers.ts";

const oid = (text: string) => createHash("sha1").update(`blob ${text.length}\0${text}`).digest("hex");
const text = (value: ReturnType<GitPackResolver["get"]>) => new TextDecoder().decode(value.read(0, value.byteLength));

test("decoded budget spans objects and rolls back failed additions", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const resolver = new GitPackResolver(storage, 10, 8);
	resolver.add(12, "blob", new TextEncoder().encode("abc"));
	assert.throws(() => resolver.add(12, "blob", new Uint8Array(4)), /UNIQUE/);
	resolver.add(30, "blob", new TextEncoder().encode("defgh"));
	assert.throws(() => resolver.add(50, "blob", new Uint8Array(1)), /total decoded byte limit/);
	assert.equal(text(resolver.get(oid("defgh"))), "defgh");
	assert.equal(storage.db.prepare("SELECT decoded FROM git_object_budget").get()!.decoded, 8);
	resolver.dispose();
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_budget").get()!.n, 0);
});

test("delta results consume budget and failed resolution rolls back all accounting", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const resolver = new GitPackResolver(storage, 100, 6);
	resolver.add(12, "blob", new TextEncoder().encode("abc"));
	resolver.add(30, "delta", new Uint8Array([3, 4, 0x90, 3, 1, 100]), 12);
	assert.throws(() => resolver.resolve(), /total decoded byte limit/);
	assert.equal(
		storage.db.prepare("SELECT decoded FROM git_object_budget WHERE scope NOT LIKE '%:raw'").get()!.decoded,
		3,
	);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n, 2);
	assert.throws(() => resolver.get(oid("abcd")), /missing/);
	resolver.dispose();
});

test("raw deltas have a separate bounded budget and are not counted as expanded versions", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const resolver = new GitPackResolver(storage, 100, 7);
	resolver.add(12, "blob", new TextEncoder().encode("abc"));
	resolver.add(30, "delta", new Uint8Array([3, 4, 0x90, 3, 1, 100]), 12);
	resolver.resolve();
	assert.equal(text(resolver.get(oid("abcd"))), "abcd");
	assert.equal(storage.db.prepare("SELECT SUM(bytes) AS n FROM git_object_meta").get()!.n, 7);
	assert.equal(
		storage.db.prepare("SELECT decoded FROM git_object_budget WHERE scope NOT LIKE '%:raw'").get()!.decoded,
		7,
	);
	assert.equal(storage.db.prepare("SELECT decoded FROM git_object_budget WHERE scope LIKE '%:raw'").get()!.decoded, 6);
	assert.throws(() => resolver.add(45, "delta", new Uint8Array([3, 4, 0x90, 3, 1, 100]), 12), /total delta byte limit/);
	assert.throws(() => resolver.add(50, "blob", new Uint8Array(1)), /total decoded byte limit/);
	resolver.resolve();
	resolver.dispose();
});

test("disk pack resolver handles forward ID bases and offset delta chains", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const resolver = new GitPackResolver(storage, 1000);
	resolver.add(12, "delta", new Uint8Array([3, 4, 0x90, 3, 1, 100]), oid("abc"));
	resolver.add(40, "blob", new TextEncoder().encode("abc"));
	resolver.add(80, "delta", new Uint8Array([4, 5, 0x90, 4, 1, 101]), 12);
	resolver.resolve();
	for (const expected of ["abc", "abcd", "abcde"]) assert.equal(text(resolver.get(oid(expected))), expected);
	resolver.resolve();
	resolver.dispose();
	assert.throws(() => resolver.get(oid("abc")), /closed/);
	for (const table of ["git_pack_resolve", "git_object_meta", "git_object_bytes"])
		assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
});

test("unresolved references roll back earlier resolutions in the same pass", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const resolver = new GitPackResolver(storage, 1000);
	resolver.add(12, "blob", new TextEncoder().encode("abc"));
	resolver.add(40, "delta", new Uint8Array([3, 4, 0x90, 3, 1, 100]), 12);
	resolver.add(80, "delta", new Uint8Array([0, 0]), "f".repeat(40));
	const before = storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n;
	assert.throws(() => resolver.resolve(), /unresolved or cyclic/);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n, before);
	assert.throws(() => resolver.get(oid("abcd")), /missing/);
	assert.equal(text(resolver.get(oid("abc"))), "abc");
	resolver.dispose();
});

test("decoded objects stream into the resolver and producer failures roll back", (t) => {
	const storage = memoryStorage();
	const resolver = new GitPackResolver(storage, 1000000);
	t.after(() => {
		try {
			resolver.dispose();
		} finally {
			storage.db.close();
		}
	});
	const expected = createHash("sha1").update("blob 800000\0");
	resolver.addChunks(12, "blob", (write) => {
		for (let i = 0; i < 100; i++) {
			const chunk = new Uint8Array(8000).fill(i);
			expected.update(chunk);
			write(chunk);
		}
	});
	resolver.resolve();
	const object = resolver.get(expected.digest("hex"));
	assert.equal(object.byteLength, 800000);
	assert.deepEqual(object.read(799990, 10), new Uint8Array(10).fill(99));
	assert.ok(Number(storage.db.prepare("SELECT MAX(length(data)) AS n FROM git_object_bytes").get()!.n) <= 65536);
	const before = storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n;
	assert.throws(
		() =>
			resolver.addChunks(40, "blob", (write) => {
				write(new Uint8Array(70000));
				throw Error("inflate failed");
			}),
		/inflate failed/,
	);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_meta").get()!.n, before);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_resolve WHERE offset = 40").get()!.n, 0);
});
