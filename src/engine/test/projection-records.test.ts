import assert from "node:assert/strict";
import { test } from "node:test";
import {
	projectionAttributes,
	projectionAttributeValue,
	projectionChildRoot,
	projectionMarker,
	projectionMembership,
} from "../experimental/projection-records.ts";

test("experimental projection record decoders reject contradictory persisted state", () => {
	const file = { kind: "file", enter: 1, exit: 2, contributions: 0 };
	assert.deepEqual(projectionMarker(file), file);
	const line = { kind: "line", enter: 3, exit: 4, parentKey: 0, key: "0".repeat(57) };
	assert.deepEqual(projectionMarker(line), line);
	for (const value of [
		{ ...file, exit: 1 },
		{ ...file, parentKey: 0 },
		{ ...line, key: "f" },
		{ ...line, parentKey: 2 ** 32 },
		{ ...line, enter: -1 },
	])
		assert.throws(() => projectionMarker(value), /invalid projection/);
	assert.deepEqual(projectionMembership({ present: true, dependents: 2 }), { present: true, dependents: 2 });
	for (const value of [
		{ present: false, dependents: 1 },
		{ present: true, dependents: -1 },
		{ present: true, dependents: 0.5 },
		{ present: 1, dependents: 0 },
	])
		assert.throws(() => projectionMembership(value), /invalid projection/);
	assert.deepEqual(projectionChildRoot({ root: null }), { root: null });
	assert.throws(() => projectionChildRoot({ root: NaN }), /invalid projection/);
	const roots = { exec: 4, link: null };
	assert.deepEqual(projectionAttributes(roots), roots);
	assert.notEqual(projectionAttributes(roots), roots);
	assert.throws(() => projectionAttributes({ unknown: 0 }), /invalid projection/);
	assert.throws(() => projectionAttributes({ exec: -1 }), /invalid projection/);
	assert.deepEqual(projectionAttributeValue({ value: null }), { value: null });
	assert.throws(() => projectionAttributeValue({ value: 4 }), /invalid projection/);
});
