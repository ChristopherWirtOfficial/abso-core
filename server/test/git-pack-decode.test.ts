import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { GitDiskIntake } from "../src/git-disk-intake.ts";
import { decodeGitPack, type PackInflater } from "../src/git-pack-decode.ts";
import { GitPackResolver } from "../src/git-pack-resolver.ts";
import { GitPackSpool } from "../src/git-pack-spool.ts";
import { memoryStorage } from "./helpers.ts";

const require = createRequire(import.meta.url);
const { Inflate } = require("pako") as {
	Inflate: new (options: { chunkSize: number }) => PackInflater;
};

test("cold intake recovery removes abandoned scratch and preserves project rows", () => {
	const storage = memoryStorage();
	try {
		GitDiskIntake.recover(storage);
		storage.sql.exec("CREATE TABLE canonical_fixture (value TEXT)");
		storage.sql.exec("INSERT INTO canonical_fixture VALUES (?)", "preserved");
		const resolver = new GitPackResolver(storage, 1000);
		resolver.add(12, "blob", new TextEncoder().encode("abc"));
		storage.sql.exec("INSERT INTO git_pack_spool VALUES (?, ?, ?)", "abandoned", 0, new Uint8Array([1]));
		GitDiskIntake.recover(storage);
		GitDiskIntake.recover(storage);
		for (const table of ["git_pack_spool", "git_pack_resolve", "git_object_meta", "git_object_bytes"])
			assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
		assert.equal(storage.db.prepare("SELECT value FROM canonical_fixture").get()!.value, "preserved");
	} finally {
		storage.db.close();
	}
});

test("disk intake exposes only verified objects and disposes all scratch", async () => {
	const storage = memoryStorage();
	try {
		for (const corrupt of [false, true]) {
			const intake = new GitDiskIntake(storage, 1000000, 1000000);
			const cache = {};
			intake.attach(cache);
			assert.equal(Reflect.get(cache, Symbol.for("abso.git.disk-pack")), intake);
			assert.throws(() => intake.attach(cache), /already attached/);
			assert.equal(intake.read("0".repeat(40)), undefined);
			const bytes = pack([Buffer.concat([objectHeader(3, 3), deflateSync(Buffer.from("abc"))])]);
			if (corrupt) bytes[bytes.length - 1]! ^= 1;
			try {
				if (corrupt) {
					await assert.rejects(
						intake.ingest([bytes], () => new Inflate({ chunkSize: 16384 })),
						/checksum/,
					);
					assert.throws(() => intake.read("0".repeat(40)), /closed/);
				} else {
					await intake.ingest([bytes], () => new Inflate({ chunkSize: 16384 }));
					const oid = createHash("sha1").update("blob 3\0abc").digest("hex");
					assert.equal(intake.read(oid)!.object.toString(), "abc");
					assert.equal(intake.read("0".repeat(40)), undefined);
					assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_spool").get()!.n, 0);
				}
			} finally {
				intake.dispose();
			}
			for (const table of ["git_pack_spool", "git_pack_resolve", "git_object_meta", "git_object_bytes"])
				assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
		}
	} finally {
		storage.db.close();
	}
});
test("late input cannot recreate scratch after intake disposal", async () => {
	const storage = memoryStorage();
	const intake = new GitDiskIntake(storage, 1000000, 1000000);
	let sourceClosed = false;
	async function* source() {
		try {
			yield new Uint8Array(65536);
			intake.dispose();
			yield new Uint8Array(65536);
		} finally {
			sourceClosed = true;
		}
	}
	try {
		await assert.rejects(
			intake.ingest(source(), () => new Inflate({ chunkSize: 16384 })),
			/closed/,
		);
		assert.equal(sourceClosed, true);
		for (const table of ["git_pack_spool", "git_pack_resolve", "git_object_meta", "git_object_bytes"])
			assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
	} finally {
		intake.dispose();
		storage.db.close();
	}
});

function objectHeader(kind: number, size: number): Uint8Array {
	const bytes = [(kind << 4) | (size & 15)];
	size = Math.floor(size / 16);
	while (size) {
		bytes[bytes.length - 1]! |= 128;
		bytes.push(size & 127);
		size = Math.floor(size / 128);
	}
	return Uint8Array.from(bytes);
}
function pack(entries: Uint8Array[]): Uint8Array {
	const header = Buffer.alloc(12);
	header.write("PACK");
	header.writeUInt32BE(2, 4);
	header.writeUInt32BE(entries.length, 8);
	const body = Buffer.concat([header, ...entries]);
	return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

test("verified disk pack inflates large objects and forward deltas without collected output", async () => {
	const storage = memoryStorage();
	const spool = new GitPackSpool(storage);
	const resolver = new GitPackResolver(storage, 2000000);
	try {
		const large = randomBytes(800000);
		const base = Buffer.from("abc");
		const baseId = createHash("sha1").update("blob 3\0").update(base).digest();
		const delta = Uint8Array.from([3, 4, 0x90, 3, 1, 100]);
		const bytes = pack([
			Buffer.concat([objectHeader(7, delta.length), baseId, deflateSync(delta)]),
			Buffer.concat([objectHeader(3, large.length), deflateSync(large)]),
			Buffer.concat([objectHeader(3, base.length), deflateSync(base)]),
		]);
		await spool.ingest([bytes], 2000000);
		decodeGitPack(spool, resolver, () => {
			const inflater = new Inflate({ chunkSize: 16384 });
			Object.defineProperty(inflater, "result", {
				set(value: Uint8Array) {
					assert.equal(value.length, 0, "inflater must not collect decoded bytes");
				},
			});
			return inflater;
		});
		const largeId = createHash("sha1").update(`blob ${large.length}\0`).update(large).digest("hex");
		const stored = resolver.get(largeId);
		for (let at = 0; at < large.length; at += 65536) {
			const n = Math.min(65536, large.length - at);
			assert.deepEqual(stored.read(at, n), new Uint8Array(large.subarray(at, at + n)));
		}
		const deltaId = createHash("sha1").update("blob 4\0abcd").digest("hex");
		assert.equal(new TextDecoder().decode(resolver.get(deltaId).read(0, 4)), "abcd");
	} finally {
		resolver.dispose();
		spool.dispose();
		storage.db.close();
	}
});

test("invalid later pack entries clear earlier decoded objects and close the resolver", async () => {
	const valid = Buffer.concat([objectHeader(3, 3), deflateSync(Buffer.from("abc"))]);
	const cases = [
		Buffer.concat([objectHeader(3, 4), deflateSync(Buffer.from("abc"))]),
		Buffer.concat([objectHeader(3, 2), deflateSync(Buffer.from("abc"))]),
		Buffer.concat([objectHeader(3, 3), deflateSync(Buffer.from("abc")).subarray(0, 3)]),
		Uint8Array.from([0]),
		Buffer.concat([objectHeader(6, 0), Uint8Array.from([0]), deflateSync(new Uint8Array())]),
		Buffer.concat([objectHeader(7, 2), Buffer.alloc(20, 255), deflateSync(Uint8Array.from([0, 0]))]),
	];
	for (const invalid of cases) {
		const storage = memoryStorage();
		const spool = new GitPackSpool(storage);
		const resolver = new GitPackResolver(storage, 1000000);
		try {
			await spool.ingest([pack([valid, invalid])], 1000000);
			assert.throws(() => decodeGitPack(spool, resolver, () => new Inflate({ chunkSize: 16384 })));
			assert.throws(() => resolver.get("0".repeat(40)), /closed/);
			for (const table of ["git_pack_resolve", "git_object_meta", "git_object_bytes"])
				assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
		} finally {
			resolver.dispose();
			spool.dispose();
			storage.db.close();
		}
	}
});
