// abso autosettle's words (abso-core 23): each choice said plainly, the gate when stopped, and who changed it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { autosettleWords, holdWords } from "../src/autosettle-commands.ts";

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

test("a held push in the history: what the model said, whether abso was told to settle it, and what was then kept", () => {
	const words = holdWords({
		id: 2,
		time: "2026-10-15T07:03:19.030Z",
		agent: "docs",
		message: "Fix the jion typo, and say to pull after joining\n\nSettled automatically (abso 19):",
		mode: "settle",
		at: 0.5,
		collisions: [
			{
				file: "docs/start.md",
				theirs: { agent: "client", version: 2 },
				advice: { pick: "yours", confidence: 0.81, by: "model", reason: "r" },
				settled: true,
				outcome: { kept: "yours", auto: true, version: 3 },
			},
			{
				file: "src/network.ts",
				theirs: { agent: "client" },
				advice: { pick: "theirs", confidence: 1, by: "rule", reason: "r" },
				settled: false,
				outcome: null,
			},
		],
	});
	assert.equal(
		words,
		[
			'2: docs, 2026-10-15T07:03:19.030Z, under settle at 0.50: "Fix the jion typo, and say to pull after joining"',
			"  docs/start.md, against client's version 2: advised keep yours (model, 0.81), told to settle; kept yours automatically in version 3.",
			"  src/network.ts, against client: advised keep theirs (a check in code); not settled yet.",
		].join("\n"),
	);
});
