// Score a model against how agents really settled past holds (#19).
//
//   node scripts/autosettle/score.ts <cases.json> [--via workers-ai|jev] [--model <id>] [--out <report.json>]
//
// --via workers-ai (the default) needs the Worker in workers-ai/ running under wrangler dev.
//
// A case is one settled collision: base, yours, theirsLines, context, both
// pushes' messages, and `kept` from the server's settled record (yours, theirs,
// both, or rewrote, which counts as "agent": a hand edit). --via jev needs JEV_API_KEY.

import { readFileSync, writeFileSync } from "node:fs";
import { ask, dollars, type Hold, PICKS, type Pick } from "./jev.ts";
import { askWorkersAi } from "./workers-ai.ts";

/** What score needs from either model. */
interface Verdict {
	pick: Pick;
	confidence: number;
	model: string;
	ms: number;
	inputTokens: number;
	reason?: string;
	probabilities?: Record<Pick, number>;
	orders?: readonly { pick: Pick }[];
}

interface Case {
	id: string;
	file: string;
	kind?: string;
	settler: { agent: string; heldMessage?: string; settleMessage?: string };
	theirs: { agent: string; version: number; message?: string };
	base: string[] | null;
	yours: string[] | null;
	theirsLines: string[] | null;
	context?: { before?: string[]; after?: string[] };
	kept: "yours" | "theirs" | "both" | "rewrote";
	issue?: string | null;
}

const truth = (kept: Case["kept"]): Pick => (kept === "rewrote" ? "agent" : kept);

function holdOf(c: Case): Hold {
	return {
		file: c.file,
		base: c.base ?? [],
		yours: c.yours ?? [],
		theirs: c.theirsLines ?? [],
		before: c.context?.before ?? [],
		after: c.context?.after ?? [],
		yourAgent: c.settler.agent,
		...(c.settler.heldMessage ? { yourMessage: c.settler.heldMessage } : {}),
		theirAgent: c.theirs.agent,
		...(c.theirs.message ? { theirMessage: c.theirs.message } : {}),
		...(c.issue ? { issue: c.issue } : {}),
	};
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

const args = process.argv.slice(2);
const via = flag(args, "--via") ?? "workers-ai";
const cases = (JSON.parse(readFileSync(args[0]!, "utf8")) as Case[]).filter(
	(c) => c.yours !== null && c.theirsLines !== null,
);
const rows: { id: string; truth: Pick; verdict: Verdict; right: boolean }[] = [];
for (const c of cases) {
	try {
		const model = flag(args, "--model") ? { model: flag(args, "--model")! } : {};
		const verdict: Verdict = via === "jev" ? await ask(holdOf(c), model) : await askWorkersAi(holdOf(c), model);
		const t = truth(c.kept);
		rows.push({ id: c.id, truth: t, verdict, right: verdict.pick === t });
		console.log(
			`${verdict.pick === t ? "agree" : "DIFFER"}  ${c.id}: agent ${t}, model ${verdict.pick} ${verdict.confidence.toFixed(2)} (${verdict.ms.toFixed(0)} ms)`,
		);
	} catch (e) {
		console.log(`error   ${c.id}: ${(e as Error).message}`);
	}
}

const mean = (xs: number[]) => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const right = rows.filter((r) => r.right);
const wrong = rows.filter((r) => !r.right);
const ms = rows.map((r) => r.verdict.ms).sort((a, b) => a - b);
const tokens = rows.map((r) => r.verdict.inputTokens);
const at = (threshold: number) => {
	const sure = rows.filter((r) => r.verdict.confidence >= threshold);
	return { threshold, settled: sure.length, agreed: sure.filter((r) => r.right).length };
};
const report = {
	via,
	model: rows[0]?.verdict.model,
	cases: rows.length,
	skipped: cases.length - rows.length,
	agreed: right.length,
	confidenceWhenRight: mean(right.map((r) => r.verdict.confidence)),
	confidenceWhenWrong: mean(wrong.map((r) => r.verdict.confidence)),
	thresholds: [0.3, 0.5, 0.6, 0.7, 0.8, 0.9].map(at),
	confusion: Object.fromEntries(
		PICKS.map((t) => [
			t,
			Object.fromEntries(PICKS.map((p) => [p, rows.filter((r) => r.truth === t && r.verdict.pick === p).length])),
		]),
	),
	ordersDisagreed: rows.filter((r) => r.verdict.orders && r.verdict.orders[0]!.pick !== r.verdict.orders[1]!.pick)
		.length,
	latencyMs: { median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1], mean: mean(ms) },
	inputTokensMean: mean(tokens),
	...(via === "jev" ? { dollarsPerCall: dollars(mean(tokens)) } : {}),
	rows: rows.map((r) => ({
		id: r.id,
		agent: r.truth,
		model: r.verdict.pick,
		confidence: r.verdict.confidence,
		probabilities: r.verdict.probabilities,
		orders: r.verdict.orders?.map((o) => o.pick),
		reason: r.verdict.reason,
		ms: Math.round(r.verdict.ms),
	})),
};
const out = flag(args, "--out");
if (out) writeFileSync(out, JSON.stringify(report, null, "\t"));
const { rows: _, ...summary } = report;
console.log(JSON.stringify(summary, null, "\t"));
