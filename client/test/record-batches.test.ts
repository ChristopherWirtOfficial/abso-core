import assert from "node:assert/strict";
import test from "node:test";
import { Api, ApiError, type RecordAnswer } from "../src/api.ts";
import {
	batchRecordItems,
	RECORD_BODY_BUDGET,
	type RecordBatch,
	type RecordItem,
	RecordItemTooLargeError,
	sendRecordBatch,
	sendRecordBatches,
	serializedRecordBytes,
} from "../src/record-batches.ts";

test("batches use serialized UTF-8 bytes and keep text, mode, blob, and deletion entries atomic", () => {
	const items: RecordItem[] = [
		{ path: "delete.txt", text: null },
		{ path: "blob.bin", text: "", mode: { exec: true }, blob: "a".repeat(64) },
		{ path: "emoji.txt", text: "🙂".repeat(80) },
	];
	const onePath = batchRecordItems([items[2]!], 10_000)[0]!;
	const exact = serializedRecordBytes(onePath);
	assert.equal(batchRecordItems([items[2]!], exact).length, 1);
	assert.throws(() => batchRecordItems([items[2]!], exact - 1), RecordItemTooLargeError);

	const batches = batchRecordItems(items, exact + 100);
	assert.deepEqual(
		batches.flatMap((batch) => batch.paths),
		["blob.bin", "delete.txt", "emoji.txt"],
	);
	assert.ok(batches.every((batch) => serializedRecordBytes(batch) <= exact + 100));
	const blobBatch = batches.find((batch) => batch.paths.includes("blob.bin"))!;
	assert.deepEqual(blobBatch.files, { "blob.bin": "", "delete.txt": null });
	assert.deepEqual(blobBatch.modes, { "blob.bin": { exec: true } });
	assert.deepEqual(blobBatch.blobs, { "blob.bin": "a".repeat(64) });
	assert.ok(blobBatch.paths.includes("delete.txt"));
});

test("a single entry over the budget is refused before any request can be sent", () => {
	assert.throws(() => batchRecordItems([{ path: "big.txt", text: "x".repeat(100) }], 20), /Not recorded: big\.txt/);
	assert.equal(RECORD_BODY_BUDGET, 8 * 1024 * 1024);
});

test("an ambiguous lost reply retries the exact batch once, then returns the accepted result", async () => {
	const batch: RecordBatch = {
		files: { "a.txt": "same\n" },
		modes: {},
		blobs: {},
		paths: ["a.txt"],
	};
	const calls: unknown[][] = [];
	let accepted = false;
	const api = {
		async record(...args: unknown[]): Promise<RecordAnswer> {
			calls.push(args);
			if (!accepted) {
				accepted = true;
				throw new ApiError("response ended before confirmation", 200);
			}
			return { ok: true, changed: [], news: [] };
		},
	};
	assert.deepEqual(await sendRecordBatch(api, batch), { ok: true, changed: [], news: [] });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], calls[1]);
});

test("the real Api transport retries an accepted request when reading its response stream fails", async () => {
	const api = new Api({ server: "https://example.test", project: "p", agent: "a", token: "t" });
	let requests = 0;
	api.send = async () => {
		requests += 1;
		if (requests === 1) {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("lost response stream"));
					},
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ ok: true, changed: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const answer = await sendRecordBatch(api, {
		files: { "a.txt": "same\n" },
		modes: {},
		blobs: {},
		paths: ["a.txt"],
	});
	assert.equal(answer.ok, true);
	assert.equal(requests, 2);
});

test("the real Api transport does not retry a definite refusal with a broken response stream", async () => {
	const api = new Api({ server: "https://example.test", project: "p", agent: "a", token: "t" });
	let requests = 0;
	api.send = async () => {
		requests += 1;
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error("broken refusal response"));
				},
			}),
			{ status: 413 },
		);
	};
	await assert.rejects(
		sendRecordBatch(api, { files: { "a.txt": "x" }, modes: {}, blobs: {}, paths: ["a.txt"] }),
		(error: unknown) => error instanceof ApiError && error.status === 413,
	);
	assert.equal(requests, 1);
});

test("a definite server refusal is not retried", async () => {
	let calls = 0;
	const api = {
		async record(): Promise<RecordAnswer> {
			calls += 1;
			throw new ApiError("bad request", 413);
		},
	};
	await assert.rejects(sendRecordBatch(api, { files: { "a.txt": "x" }, modes: {}, blobs: {}, paths: ["a.txt"] }));
	assert.equal(calls, 1);
});

test("later batch failure stops the sequence and confirms only successful batches", async () => {
	const batches: RecordBatch[] = ["a.txt", "b.txt", "c.txt"].map((path) => ({
		files: { [path]: path },
		modes: {},
		blobs: {},
		paths: [path],
	}));
	const sent: string[] = [];
	const confirmed: string[] = [];
	const api = {
		async record(files: Record<string, string | null>): Promise<RecordAnswer> {
			const path = Object.keys(files)[0]!;
			sent.push(path);
			if (path === "b.txt") throw new ApiError("request rejected", 413);
			return { ok: true, changed: [path] };
		},
	};
	await assert.rejects(
		sendRecordBatches(
			api,
			batches,
			async () => {},
			async (batch) => {
				confirmed.push(batch.paths[0]!);
			},
		),
		/request rejected/,
	);
	assert.deepEqual(sent, ["a.txt", "b.txt"]);
	assert.deepEqual(confirmed, ["a.txt"]);
});
