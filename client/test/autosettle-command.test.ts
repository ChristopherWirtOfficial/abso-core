// abso autosettle's words (abso-core 23): each choice said plainly, the gate when stopped, and who changed it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { autosettleWords } from "../src/autosettle-commands.ts";

test("each choice is said plainly, with the gate when it's stopped and who changed it last", () => {
	assert.match(
		autosettleWords({ project: "p", mode: "off", at: 0.5 }),
		/^p is on Off: held pushes come back as they always have\.$/,
	);
	assert.match(autosettleWords({ project: "p", mode: "advise", at: 0.5 }), /The agent still settles\./);
	const settle = autosettleWords({
		project: "p",
		mode: "settle",
		at: 0.6,
		gate: "stopped",
		changedBy: "christopher",
		changedAt: "2026-10-15T07:00:00.000Z",
	});
	assert.match(settle, /^p is on Settle at 0\.60: /);
	assert.match(settle, /Stopped by abso for now/);
	assert.match(settle, /Last changed by christopher, 2026-10-15T07:00:00\.000Z\.$/);
});
