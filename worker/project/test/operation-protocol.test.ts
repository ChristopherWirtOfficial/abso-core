import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalJson,
	chunkEntries,
	digestOperation,
	type OperationChunk,
	type ProjectOperation,
	utf8JsonFrames,
} from "../operation-protocol.ts";
import type { Entry } from "../project-types.ts";

const operation: ProjectOperation = {
	id: "op-1",
	tenant: "tenant-1",
	project: "project-1",
	incarnation: "incarnation-1",
	actor: "builder",
	build: "build-1",
	executorIdentity: "trusted-local-executor",
	rootDigest: "root-0",
	authorizationRevision: "auth-1",
	policyRevision: "policy-1",
	operationTime: 20,
	queuePolicy: { policyRevision: "policy-1", checkerReady: false },
	generation: 0,
	heads: { log: 0, shared: 0, actorMine: 0, actorBase: 0, queueRevision: 0 },
	message: "record and publish",
	files: { "readme.txt": "updated\n" },
};

test("canonical request binding ignores object property order and binds every request field", async () => {
	const reordered = {
		...operation,
		files: { "readme.txt": "updated\n" },
		heads: { actorBase: 0, actorMine: 0, shared: 0, log: 0, queueRevision: 0 },
	};
	assert.equal(await digestOperation(operation), await digestOperation(reordered));
	assert.notEqual(
		await digestOperation(operation),
		await digestOperation({ ...operation, authorizationRevision: "revoked" }),
	);
	assert.notEqual(
		await digestOperation(operation),
		await digestOperation({ ...operation, files: { "readme.txt": "other\n" } }),
	);
	assert.notEqual(await digestOperation(operation), await digestOperation({ ...operation, operationTime: 21 }));
	assert.notEqual(
		await digestOperation(operation),
		await digestOperation({ ...operation, queuePolicy: { ...operation.queuePolicy, checkerReady: true } }),
	);
	assert.equal(canonicalJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
});

test("chunk generator preserves exact order with bounded entries and UTF-8 byte accounting", async () => {
	const entries: Entry[] = Array.from({ length: 70 }, (_, index) => ({
		type: "join",
		agent: `agent-${index}`,
		version: index,
		time: index,
	}));
	const chunks: OperationChunk[] = [];
	for await (const chunk of chunkEntries(entries)) chunks.push(chunk);
	assert.deepEqual(
		chunks.flatMap((chunk) => chunk.entries),
		entries,
	);
	assert.ok(chunks.every((chunk, index) => chunk.index === index && chunk.count <= 32 && chunk.bytes <= 64 * 1024));
	assert.deepEqual(
		chunks.map((chunk) => chunk.firstEntry),
		[0, 32, 64],
	);
	assert.ok(chunks.every((chunk, index) => index === 0 || chunk.chain !== chunks[index - 1]!.chain));

	const large: Entry = { type: "join", agent: "🙂".repeat(8_000), version: 0, time: 1 };
	const utf8: OperationChunk[] = [];
	for await (const chunk of chunkEntries([large])) utf8.push(chunk);
	assert.ok(utf8[0]!.bytes > JSON.stringify(large).length);
	assert.ok(utf8[0]!.bytes <= 64 * 1024);
	const largeEntry: Entry = { type: "join", agent: `🙂\n"`.repeat(20_000), version: 0, time: 1 };
	const frames = [...utf8JsonFrames(largeEntry)];
	assert.ok(frames.length > 1);
	assert.ok(frames.every((frame) => frame.bytes <= 64 * 1024));
	assert.deepEqual(JSON.parse(frames.map((frame) => frame.text).join("")), largeEntry);
});
