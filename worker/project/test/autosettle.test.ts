import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ai, adviseHeld, autoSettledOf, autoTrailer, refused, ruled, withAdvice } from "../autosettle.ts";
import { outlastsSync, settledItem } from "../news.ts";

/**
 * A stand-in for Workers AI that always leans to `pick`: a System One answer for Clef (`top` on `pick`, the rest
 * spread evenly) or a JSON-mode answer for a text model. It counts its calls.
 */
function fakeAi(pick: string, top = 0.85): Ai & { calls: number } {
	const ai = {
		calls: 0,
		async run(_model: string, input: unknown) {
			ai.calls++;
			if ((input as { questions?: unknown }).questions) {
				const probabilities = Object.fromEntries(
					["yours", "theirs", "both", "agent"].map((k) => [k, k === pick ? top : (1 - top) / 3]),
				);
				return {
					answers: {
						settle: { type: "choice", probabilities },
						settle_reversed: { type: "choice", probabilities },
					},
				};
			}
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
const routes = held('\t"/blame": blame,\n', '\t"/search": search,\n');
const me = { agent: "me", message: "my reason" };

test("code settles when one side's lines are all in the other's, without asking the model", async () => {
	const ai = fakeAi("both");
	const [a] = await adviseHeld(ai, [held("\ttimeoutMs: 30000,\n", "\ttimeoutMs: 30000,\n\tretries: 2,\n")], me);
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

test("Clef advises by default: one call, its confidence from the probabilities, and other kinds get no advice", async () => {
	const ai = fakeAi("both");
	const advice = await adviseHeld(ai, [routes, held("x", "y", "definition")], me);
	assert.equal(advice[0]?.pick, "both");
	assert.equal(advice[0]?.by, "model");
	assert.equal(advice[0]?.model, "@cf/cloudflare/clef");
	assert.equal(advice[0]?.confidence.toFixed(2), "0.80");
	assert.equal(advice[1], null);
	assert.equal(ai.calls, 1);
});

test("a lean to one side under the threshold goes to an agent, saying which side it leaned to", async () => {
	const [a] = await adviseHeld(fakeAi("both", 0.55), [routes], me);
	assert.equal(a?.pick, "agent");
	assert.equal(a?.by, "unsure");
	assert.equal(a?.modelPick, "both");
	const [b] = await adviseHeld(fakeAi("both", 0.55), [routes], me, { at: 0.3 });
	assert.equal(b?.pick, "both");
});

test("a text model named instead takes 5 samples, its confidence the share that agree", async () => {
	const ai = fakeAi("both");
	const [a] = await adviseHeld(ai, [routes], me, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
	assert.equal(a?.pick, "both");
	assert.equal(a?.confidence, 1);
	assert.equal(ai.calls, 5);
});

test("a model that fails leaves no advice instead of failing the push's answer", async () => {
	const ai: Ai = {
		async run() {
			throw new Error("Workers AI is down");
		},
	};
	const [a] = await adviseHeld(ai, [held("a = 1", "b = 2")], me);
	assert.equal(a, null);
});

test("the switch: off leaves the answer alone, on adds advice, act also tells the client to settle", async () => {
	const answer = { ok: false, collisions: [routes] };
	const request = { message: "my reason" };
	assert.equal(await withAdvice({ AI: fakeAi("both") }, "publish", "me", request, answer), answer);
	assert.equal(await withAdvice({ AUTOSETTLE: "on", AI: fakeAi("both") }, "draft", "me", request, answer), answer);
	const on = (await withAdvice({ AUTOSETTLE: "on", AI: fakeAi("both") }, "publish", "me", request, answer)) as {
		advice?: unknown[];
		settle?: boolean;
	};
	assert.equal(on.advice?.length, 1);
	assert.equal(on.settle, undefined);
	const act = (await withAdvice({ AUTOSETTLE: "act", AI: fakeAi("both") }, "publish", "me", request, answer)) as {
		settle?: boolean;
	};
	assert.equal(act.settle, true);
	const ok = { ok: true, version: 4 };
	assert.equal(await withAdvice({ AUTOSETTLE: "act", AI: fakeAi("both") }, "publish", "me", request, ok), ok);
});

test("the message trailer: the client writes what it settled by itself, and the server reads it back by file", () => {
	const trailer = autoTrailer([
		[
			"docs/start.md",
			{ pick: "yours", by: "model", confidence: 0.8125, reason: "Both fixed the typo;\nyours adds a line." },
		],
		[
			"src/network.ts",
			{ pick: "theirs", by: "rule", confidence: 1, reason: "every line of yours is already in theirs" },
		],
	]);
	assert.equal(
		trailer,
		[
			"Settled automatically (abso 19):",
			"- docs/start.md: kept yours, confidence 0.81. Both fixed the typo; yours adds a line.",
			"- src/network.ts: kept theirs, by a check in code. every line of yours is already in theirs",
		].join("\n"),
	);
	const read = autoSettledOf(`Fix the jion typo\n\n${trailer}`);
	assert.deepEqual(read.get("docs/start.md"), {
		pick: "yours",
		by: "model",
		confidence: 0.81,
		reason: "Both fixed the typo; yours adds a line.",
	});
	assert.equal(read.get("src/network.ts")?.by, "rule");
	assert.equal(autoSettledOf("Settled the typo by hand").size, 0);
});

test("the other agent's news says the settle was automatic, and still outlasts a sync", () => {
	const s = {
		file: "docs/start.md",
		kept: "yours" as const,
		theirs: { agent: "client", version: 2 },
		auto: { pick: "yours" as const, by: "model" as const, confidence: 0.81, reason: "r" },
	};
	const item = settledItem("docs", 3, s);
	assert.equal(outlastsSync(item.text), true);
	assert.match(
		item.text,
		/^docs settled its collision with your version 2 in docs\/start\.md automatically, as abso's model advised \(confidence 0\.81\), pushing version 3:/,
	);
	const byHand = settledItem("docs", 3, { ...s, auto: undefined });
	assert.match(byHand.text, /in docs\/start\.md, pushing version 3:/);
});
