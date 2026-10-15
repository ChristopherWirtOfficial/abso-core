// After "Pushed version N.", the push says whether CI will check it, from the server's `ciWhere`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ciWhereText } from "../src/publish-commands.ts";

test("CI off: the version isn't checked, and where to turn it on", () => {
	assert.deepEqual(ciWhereText("off", 1), [
		"CI is off for this project, so version 1 isn't checked. Connect a Cloudflare account in the project's settings on the website to run it there.",
	]);
});

test("CI in the project's Cloudflare account: where to see the result", () => {
	assert.deepEqual(ciWhereText("account", 7), [
		"CI checks it in the project's Cloudflare account: abso ci 7 shows the result.",
	]);
});

test("the server's own compute, a server that doesn't say, or a word this client doesn't know: nothing added", () => {
	assert.deepEqual(ciWhereText("abso", 3), []);
	assert.deepEqual(ciWhereText(undefined, 3), []);
	assert.deepEqual(ciWhereText("somewhere-new", 3), []);
});
