import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonEvents } from "../src/json-events.ts";
import { smallFrameJson } from "../src/small-frame-json.ts";

test("small decoded frames freeze nested objects and arrays", () => {
	const value = smallFrameJson(['{"items":[{"value":1}]}']) as { items: { value: number }[] };
	assert.equal(Object.isFrozen(value), true);
	assert.equal(Object.isFrozen(value.items), true);
	assert.equal(Object.isFrozen(value.items[0]), true);
	assert.throws(() => value.items.push({ value: 2 }), TypeError);
	assert.throws(() => {
		value.items[0]!.value = 3;
	}, TypeError);
	assert.deepEqual(value, { items: [{ value: 1 }] });
});

test("both JSON paths refuse non-finite numeric values", () => {
	for (const input of ["1e400", "-1e400", '{"n":1e400}', "[1e400]"]) {
		assert.throws(() => smallFrameJson([input]), /non-finite/);
		assert.throws(() => [...jsonEvents([input], { finiteNumbers: true })], /non-finite/);
	}
	assert.equal(smallFrameJson(["1e308"]), 1e308);
});
