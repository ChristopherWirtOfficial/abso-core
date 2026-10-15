// Joining a project that has nothing in it yet: the join writes no files, so it says what comes next.

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyHint } from "../src/join-commands.ts";

test("an empty project: the next step is to put files here and push", () => {
	assert.deepEqual(emptyHint(0, 0, 0, false), [
		'The project is empty. Put its files in this folder, then abso push -m "why" publishes them.',
	]);
});

test("no hint when there is anything to say instead", () => {
	assert.deepEqual(emptyHint(3, 0, 0, false), [], "shared has versions, even with no files left");
	assert.deepEqual(emptyHint(0, 2, 0, false), [], "files were written");
	assert.deepEqual(emptyHint(0, 0, 1, false), [], "files already in the folder, named by the join's own line");
	assert.deepEqual(emptyHint(0, 0, 0, true), [], "a reader can't push");
});
