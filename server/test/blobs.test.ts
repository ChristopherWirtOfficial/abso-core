import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, it } from "node:test";
import { BlobStore } from "../src/blobs.ts";
import { installDigestStream, memoryStorage, streamOf } from "./helpers.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the blob store", () => {
	before(installDigestStream);

	it("keeps bytes whose SHA-256 is their name", async () => {
		const store = new BlobStore(memoryStorage());
		const a = await store.put(sha("hello"), streamOf("hello"));
		assert.deepEqual(a, { status: 200, body: { sha256: sha("hello"), size: 5, stored: true } });
		assert.equal(store.has(sha("hello")), true);
		assert.equal(new TextDecoder().decode(store.read(sha("hello"))!), "hello");
		const again = await store.put(sha("hello"), streamOf("hello"));
		assert.equal((again.body as { stored: boolean }).stored, false);
	});

	it("refuses bytes that hash to something else, and keeps nothing", async () => {
		const store = new BlobStore(memoryStorage());
		const a = await store.put(sha("hello"), streamOf("goodbye"));
		assert.equal(a.status, 400);
		assert.match((a.body as { error: string }).error, new RegExp(`hash to ${sha("goodbye")}`));
		assert.equal(store.has(sha("hello")), false);
		assert.equal(store.has(sha("goodbye")), false);
		assert.deepEqual(store.list("", 10), { blobs: [], next: null });
	});

	it("refuses a name that isn't a lowercase SHA-256", async () => {
		const store = new BlobStore(memoryStorage());
		assert.equal((await store.put("abc", streamOf("x"))).status, 400);
		assert.equal((await store.put(sha("x").toUpperCase(), streamOf("x"))).status, 400);
	});

	it("refuses a blob over the size cap", async () => {
		const store = new BlobStore(memoryStorage());
		const a = await store.put(sha("too big"), streamOf("too big"), 3);
		assert.equal(a.status, 413);
		assert.equal(store.total(), 0);
	});
});
