import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { answer } from "../../worker/project/http.ts";
import { canonicalJson } from "../../worker/project/operation-protocol.ts";
import { DiskFirstRuntime } from "../src/disk-first-runtime.ts";
import { SqliteLog } from "../src/engine-project.ts";
import { requestIdentityDigest } from "../src/request-identity-digest.ts";
import { SqliteWriterState } from "../src/writer-host.ts";
import { memoryStorage } from "./helpers.ts";

test("request identity hashes preserve canonical bytes and legacy omission semantics", () => {
	const shared = { z: 1, a: "same" };
	for (const value of [
		null,
		true,
		false,
		0,
		-0,
		1e30,
		NaN,
		Infinity,
		{ z: [shared, shared], a: { "10": 10, "2": 2, b: undefined, c: Symbol("x"), d: () => 1 } },
		Object.assign(new Array(5), { 0: undefined, 2: null, 3: Symbol("x"), 4: () => 1 }),
		{ toJSON: () => "ignored by canonicalJson", value: "original" },
		{ body: { files: { "large.txt": `${"x".repeat(16383)}🚀${'\u0000\n"\\é中\ud800'.repeat(100000)}` } } },
	]) {
		assert.equal(requestIdentityDigest(value), createHash("sha256").update(canonicalJson(value)).digest("hex"));
	}
});

test("large request strings never reach a whole-string JSON encoder", (t) => {
	const value = { body: { files: { "a.txt": "🚀abc\n".repeat(500000) } } };
	const expected = createHash("sha256").update(canonicalJson(value)).digest("hex");
	const stringify = JSON.stringify;
	t.mock.method(JSON, "stringify", (input: unknown) => {
		if (typeof input === "string") assert.ok(input.length <= 16384);
		else assert.ok(input === null || typeof input !== "object", "whole request serialization forbidden");
		return stringify(input);
	});
	assert.equal(requestIdentityDigest(value), expected);
});

test("invalid identities fail instead of hashing a different value", () => {
	for (const value of [undefined, Symbol("x"), () => 1, 1n]) assert.throws(() => requestIdentityDigest(value));
	const cyclic: unknown[] = [];
	cyclic.push(cyclic);
	assert.throws(() => requestIdentityDigest(cyclic), /cyclic/);
});

test("a reopened runtime replays legacy receipts without executing the operation", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "legacy-identity", "legacy-identity");
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	const state = new SqliteWriterState(storage, "legacy-identity");
	const identity = { z: "last", body: { files: { "a.txt": "new\n" } }, a: "first" };
	const digest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
	const result = { status: 200, body: "🚀\n".repeat(40000) };
	const json = JSON.stringify({ result });
	const parts = Math.ceil(json.length / 65536);
	for (let part = 0; part < parts; part++)
		state.write("runtime:receipt:legacy-3", String(part), json.slice(part * 65536, (part + 1) * 65536));
	state.write("runtime:receipts", "legacy-3", {
		format: 3,
		identity: digest,
		parts,
		characters: json.length,
		digest: createHash("sha256").update(json).digest("hex"),
	});
	state.write("runtime:receipts", "legacy-2", { format: 2, identity: digest, result });
	const before = new SqliteLog(storage).seq();
	for (const id of ["legacy-2", "legacy-3"]) {
		assert.deepEqual(
			runtime().write(
				() => {
					throw Error("legacy operation executed twice");
				},
				() => {},
				{ id, identity },
			),
			result,
		);
		assert.throws(
			() =>
				runtime().write(
					() => result,
					() => {},
					{ id, identity: { changed: true } },
				),
			/reused/,
		);
		assert.throws(
			() =>
				runtime().write(
					() => result,
					() => {
						throw Error("revoked");
					},
					{ id, identity },
				),
			/revoked/,
		);
	}
	assert.equal(new SqliteLog(storage).seq(), before);
});

test("receipt streaming preserves deep results and boxed primitive JSON behavior", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const runtime = () => new DiskFirstRuntime(storage, "receipt-compat", "receipt-compat");
	runtime().initialize(
		(calls) => answer(calls, "init", undefined, { files: { "a.txt": "one\n" } }),
		() => {},
	);
	while (!runtime().preparePage(() => {}).ready) {}
	let deep: unknown = "leaf";
	for (let i = 0; i < 200; i++) deep = { child: deep };
	const values = [deep, new String("boxed"), new Number(42), new Boolean(false)];
	for (let i = 0; i < values.length; i++) {
		const request = { id: "compat-" + i, identity: { i } };
		const before = new SqliteLog(storage).seq();
		runtime().write(
			(calls) => {
				const result = answer(calls, "record", "fixture", { files: { "a.txt": "value-" + i } });
				assert.equal(result.status, 200);
				return values[i];
			},
			() => {},
			request,
		);
		assert.ok(new SqliteLog(storage).seq() > before);
		assert.deepEqual(
			runtime().write(
				() => {
					throw Error("retry executed");
				},
				() => {},
				request,
			),
			JSON.parse(JSON.stringify(values[i])),
		);
	}
});
