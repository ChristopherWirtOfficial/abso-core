import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import git from "isomorphic-git";
import { GitPackSpool } from "../src/git-pack-spool.ts";
import { MemoryFS } from "../src/memory-fs.ts";
import { memoryStorage } from "./helpers.ts";

test("cold pack recovery clears abandoned scratch without changing canonical tables", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	GitPackSpool.recover(storage);
	storage.sql.exec("CREATE TABLE canonical_test (value TEXT)");
	storage.sql.exec("INSERT INTO canonical_test VALUES (?)", "preserved");
	storage.sql.exec("INSERT INTO git_pack_spool VALUES (?, ?, ?)", "abandoned", 0, new Uint8Array([1, 2]));
	GitPackSpool.recover(storage);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_spool").get()!.n, 0);
	assert.equal(storage.db.prepare("SELECT value FROM canonical_test").get()!.value, "preserved");
	GitPackSpool.recover(storage);
});

test("pack spool verifies real pack bytes and serves bounded ranges across chunk boundaries", async (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const fs = new MemoryFS(),
		dir = "/repo";
	await git.init({ fs, dir });
	const oids = [];
	for (let i = 0; i < 4; i++) oids.push(await git.writeBlob({ fs, dir, blob: randomBytes(180000) }));
	const packed = await git.packObjects({ fs, dir, oids, write: false });
	const bytes = packed.packfile!;
	const spool = new GitPackSpool(storage);
	assert.throws(() => spool.read(0, 0), /not readable/);
	async function* source() {
		for (let at = 0; at < bytes.length; at += 997) yield bytes.subarray(at, at + 997);
	}
	assert.equal(await spool.ingest(source(), 1000000), Buffer.from(bytes.subarray(-20)).toString("hex"));
	assert.equal(spool.byteLength, bytes.length);
	for (const start of [0, 65530, 65536, 131070, bytes.length - 101]) {
		const length = Math.min(101, bytes.length - start);
		assert.deepEqual(spool.read(start, length), new Uint8Array(bytes.subarray(start, start + length)));
	}
	assert.deepEqual(Buffer.concat([...spool.chunks()]), Buffer.from(bytes));
	assert.throws(() => spool.read(0, 65537), /invalid pack byte range/);
	assert.throws(() => spool.read(bytes.length, 1), /invalid pack byte range/);
	const max = storage.db.prepare("SELECT MAX(length(data)) AS n FROM git_pack_spool").get()!.n;
	assert.ok(Number(max) <= 65536);
	spool.dispose();
	assert.throws(() => spool.read(0, 0), /not readable/);
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_spool").get()!.n, 0);
	for (const mode of ["corrupt", "limit", "source-error"]) {
		const bad = new GitPackSpool(storage);
		let closed = false;
		async function* broken() {
			try {
				const data = Uint8Array.from(bytes);
				if (mode === "corrupt") data[20]! ^= 1;
				yield data.subarray(0, 100000);
				if (mode === "source-error") throw Error("injected source failure");
				yield data.subarray(100000);
			} finally {
				closed = true;
			}
		}
		await assert.rejects(bad.ingest(broken(), mode === "limit" ? 70000 : 1000000));
		assert.equal(closed, true);
		assert.throws(() => bad.read(0, 0), /not readable/);
		assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_spool").get()!.n, 0);
	}
});
