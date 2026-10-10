// What abso waiting --mine says about your own publishes in the merge queue: where each stands, a pause, and how
// the outcome comes. Nothing when none of yours waits.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueueItem, QueueState } from "../src/api.ts";
import { queuedLines } from "../src/queue.ts";

const item = (id: number, agent: string, checking = false): QueueItem => ({
	id,
	agent,
	message: `push ${id}`,
	time: 0,
	changes: 1,
	checking,
});
const state = (items: QueueItem[], paused: QueueState["paused"] = null): QueueState =>
	({ items, paused }) as unknown as QueueState;

describe("waiting: your pushes in the merge queue", () => {
	it("says nothing when none of yours waits, or there's no queue to read", () => {
		assert.deepEqual(queuedLines(undefined, "ann"), []);
		assert.deepEqual(queuedLines(state([]), "ann"), []);
		assert.deepEqual(queuedLines(state([item(1, "bob")]), "ann"), []);
	});

	it("says where yours stands, and how the outcome comes", () => {
		assert.deepEqual(queuedLines(state([item(1, "bob", true), item(2, "ann")]), "ann"), [
			'Your push 2 ("push 2") is in the merge queue: waiting, 1 push ahead of it.',
			"It lands or is turned back once the project's check runs on it; the outcome comes as news, and abso unqueue takes it back.",
		]);
		assert.deepEqual(queuedLines(state([item(3, "ann", true), item(4, "bob", true), item(5, "ann")]), "ann"), [
			'Your push 3 ("push 3") is in the merge queue: being checked in a batch of 2.',
			'Your push 5 ("push 5") is in the merge queue: waiting, 2 pushes ahead of it.',
			"Each lands or is turned back once the project's check runs on it; the outcome comes as news, and abso unqueue takes them back.",
		]);
	});

	it("says when the queue is paused", () => {
		const paused = {
			reason: "the box failed twice",
			since: "2026-01-01T00:00:00.000Z",
			nextTry: "2026-01-01T00:05:00.000Z",
		};
		assert.equal(
			queuedLines(state([item(1, "ann")], paused), "ann")[1],
			"The merge queue is paused: the box failed twice.",
		);
	});
});
