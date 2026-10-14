import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ai, adviseHeld, refused, ruled } from "../src/autosettle.ts";

/** A stand-in for Workers AI that always answers `pick`, and counts its calls. */
function fakeAi(pick: string): Ai & { calls: number } {
	const ai = {
		calls: 0,
		async run() {
			ai.calls++;
			return { response: { pick, confidence: 0.9, reason: "a fixed answer" }, usage: { prompt_tokens: 10 } };
		},
	};
	return ai;
}

const held = (yours: string, theirs: string, kind = "lines") => ({
	kind,
	file: "src/a.ts",
	yours: { lines: [3, 3] as [number, number], text: yours },
	theirs: { agent: "other", message: "their reason", text: theirs },
});

test("code settles when one side's lines are all in the other's, without asking the model", async () => {
	const ai = fakeAi("both");
	const [a] = await adviseHeld(ai, [held("\ttimeoutMs: 30000,\n", "\ttimeoutMs: 30000,\n\tretries: 2,\n")], {
		agent: "me",
		message: "my reason",
	});
	assert.equal(a?.pick, "theirs");
	assert.equal(a?.by, "rule");
	assert.equal(ai.calls, 0);
});

test("a keep-both that sets one key twice, or holds one import in two versions, goes to an agent", () => {
	const hold = (yours: string[], theirs: string[]) => ({ file: "a", base: [], yours, theirs, before: [], after: [] });
	assert.match(refused(hold(["\tmaxNesting: 64,"], ["\tmaxNesting: 1000,"]), "both") ?? "", /maxNesting twice/);
	assert.match(
		refused(hold(['import { a, b, c } from "./x.ts";'], ['import { a, b, d } from "./x.ts";']), "both") ?? "",
		/one statement in two versions/,
	);
	assert.equal(refused(hold(['\t"/blame": blame,'], ['\t"/search": search,']), "both"), undefined);
	assert.equal(ruled(hold(['\t"/blame": blame,'], ['\t"/search": search,'])), undefined);
});

test("the model's pick comes back with how many samples agree, and other kinds get no advice", async () => {
	const ai = fakeAi("both");
	const advice = await adviseHeld(
		ai,
		[held('\t"/blame": blame,\n', '\t"/search": search,\n'), held("x", "y", "definition")],
		{ agent: "me", message: "my reason" },
	);
	assert.equal(advice[0]?.pick, "both");
	assert.equal(advice[0]?.by, "model");
	assert.equal(advice[0]?.confidence, 1);
	assert.equal(advice[1], null);
	assert.equal(ai.calls, 5);
});

test("a model that fails leaves no advice instead of failing the push's answer", async () => {
	const ai: Ai = {
		async run() {
			throw new Error("Workers AI is down");
		},
	};
	const [a] = await adviseHeld(ai, [held("a = 1", "b = 2")], { agent: "me", message: "m" });
	assert.equal(a, null);
});
