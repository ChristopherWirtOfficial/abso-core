import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectionSequence } from "../experimental/projection-sequence.ts";
import { SqlState } from "./storage-helper.ts";

test("typed sequence preserves ordering, moves, old roots and rollback", () => {
	const storage = new SqlState();
	try {
		const sequence = new ProjectionSequence(storage, "test");
		let state = sequence.empty();
		const oracle: { id: number; text: string }[] = [];
		for (let i = 0; i < 64; i++) {
			const rank = i % 2 ? 0 : oracle.length;
			state = sequence.update(state, { kind: "insert", rank, text: String(i) });
			oracle.splice(rank, 0, { id: i, text: String(i) });
		}
		const original = state,
			old = structuredClone(oracle);
		for (let i = 0; i < 32; i++) {
			const from = i % 48,
				length = 1 + (i % 12),
				to = (i * 7) % (65 - length);
			state = sequence.update(state, { kind: "move", from, length, to });
			const block = oracle.splice(from, length);
			oracle.splice(to, 0, ...block);
			assert.deepEqual([...sequence.values(state)], oracle);
			for (let k = 0; k < oracle.length; k++) assert.equal(sequence.rank(state, oracle[k]!.id), k);
		}
		state = sequence.update(state, { kind: "visibility", id: 0, delta: 1 });
		assert.deepEqual(
			[...sequence.values(state)],
			oracle.filter((x) => x.id !== 0),
		);
		assert.deepEqual([...sequence.values(original)], old);
		const rows = () => JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows();
		storage.failWrite = storage.writes + 3;
		assert.throws(() => sequence.update(state, { kind: "insert", rank: 0, text: "failure" }), /injected/);
		assert.equal(rows(), before);
		storage.failWrite = Infinity;
		assert.throws(() => sequence.rank({ ...state, next: -1 }, 0), /invalid sequence state/);
		const root = sequence.get(state.map, state.root!);
		const corrupt = sequence.set(state.map, root.id, { ...root, count: root.count + 1 });
		assert.throws(() => [...sequence.values({ ...state, map: corrupt })], /inconsistent sequence aggregate/);
		assert.deepEqual([...sequence.values(original)], old);
	} finally {
		storage.db.close();
	}
});
