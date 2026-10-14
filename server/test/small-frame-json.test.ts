import assert from "node:assert/strict";
import { test } from "node:test";
import { smallFrameJson } from "../src/small-frame-json.ts";

test("small frame decoding enforces a byte bound and streamed parser rules", () => {
	assert.deepEqual(smallFrameJson(['{"type":"jo', 'in","agent":"alice"}']), { type: "join", agent: "alice" });
	assert.deepEqual(smallFrameJson(['{"x":1,"x":2}']), { x: 2 });
	assert.throws(() => smallFrameJson(['"' + "\u00e9".repeat(2048) + '"']), /exceeds bound/);
	assert.throws(() => smallFrameJson(["[".repeat(130) + "0" + "]".repeat(130)]), /nesting/);
	assert.throws(() => smallFrameJson(["1" + "0".repeat(256)]), /scalar/);
	assert.throws(() => smallFrameJson(["{} trailing"]), /trailing/);
});
test("small frame byte accounting handles a split surrogate pair at the limit", () => {
	const pair = String.fromCodePoint(0x1f600);
	const body = "x".repeat(4090) + pair;
	const json = JSON.stringify(body);
	assert.equal(new TextEncoder().encode(json).byteLength, 4096);
	const split = json.indexOf(pair) + 1;
	assert.equal(smallFrameJson([json.slice(0, split), json.slice(split)]), body);
	assert.throws(() => smallFrameJson([JSON.stringify(body + "x")]), /exceeds bound/);
});
