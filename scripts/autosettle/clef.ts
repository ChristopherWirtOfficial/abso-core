// Ask Clef, Cloudflare's decision model on Workers AI, how a hold should be settled (#19). Clef takes Jev's
// System One request (state and typed questions) and answers with a probability per option, so the questions are
// jev.ts's own; it goes through the local Worker (workers-ai/, wrangler dev), which has the AI binding.

import { type Hold, type SystemOneAnswer, systemOneBody, type Verdict, verdictOf } from "./jev.ts";
import { refused, ruled } from "./rules.ts";
import { WORKER } from "./workers-ai.ts";

export interface ClefVerdict extends Verdict {
	readonly reason?: string;
	readonly by: "rule" | "model" | "turned down";
	readonly modelPick?: Verdict["pick"];
}

/** Code's rules first, then Clef, then code's check on its pick, as for the Workers AI text model. */
export async function askClef(
	h: Hold,
	opts: { model?: "clef" | "clef-flash"; url?: string } = {},
): Promise<ClefVerdict> {
	const rule = ruled(h);
	if (rule)
		return {
			pick: rule.pick,
			reason: rule.reason,
			confidence: 1,
			probabilities: { yours: 0, theirs: 0, both: 0, agent: 0, [rule.pick]: 1 },
			orders: [],
			signs: {},
			model: "rule",
			ms: 0,
			inputTokens: 0,
			by: "rule",
		};
	const started = performance.now();
	const res = await fetch(`${opts.url ?? WORKER}/system-one`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(systemOneBody(h, opts.model ?? "clef")),
	});
	const out = (await res.json()) as SystemOneAnswer & { error?: string };
	if (!res.ok || out.error || !out.answers) throw new Error(`Clef: ${out.error ?? res.status}`);
	const v = verdictOf({ ...out, model: out.model ?? opts.model ?? "clef" }, performance.now() - started);
	const no = refused(h, v.pick);
	return no ? { ...v, pick: "agent", reason: no, by: "turned down", modelPick: v.pick } : { ...v, by: "model" };
}
