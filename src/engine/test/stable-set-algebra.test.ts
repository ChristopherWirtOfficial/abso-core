import assert from "node:assert/strict";
import { test } from "node:test";
import { differenceSet, StableOverlaySet, StableSet, unionOverlay } from "../state-source.ts";

test("indexed union and subtraction preserve order without enumerating history at construction or lookup", () => {
	class Range extends StableSet<number> {
		retainedBytes = 32;
		visited = 0;
		has(value: number): boolean {
			return Number.isInteger(value) && value >= 0 && value < 100000;
		}
		*values(): SetIterator<number> {
			for (let n = 0; n < 100000; n++) {
				this.visited++;
				yield n;
			}
		}
	}
	const history = new Range();
	const overlay = new Set([99999, 100000]);
	const union = unionOverlay(history, overlay);
	const result = differenceSet(union, new StableOverlaySet([0, 1, 99999]));
	overlay.add(100001);
	assert.ok(result instanceof StableSet);
	assert.equal(result.has(100000), true);
	assert.equal(result.has(99999), false);
	assert.equal(result.has(100001), false, "the operation overlay is an immutable snapshot");
	assert.equal(history.visited, 0);
	const iterator = result.values();
	assert.equal(iterator.next().value, 2);
	assert.equal(history.visited, 3, "the first value does not materialize the remaining history");
	iterator.return?.();
	assert.ok(result.retainedBytes < 512);
	assert.deepEqual([...differenceSet(new StableOverlaySet([3, 1, 2]), new StableOverlaySet([1]))], [3, 2]);
	assert.deepEqual([...unionOverlay(new StableOverlaySet([3, 1]), [1, 2])], [3, 1, 2]);
	assert.deepEqual([...differenceSet(new Set([3, 1, 2]), new Set([1]))], [3, 2]);
});
