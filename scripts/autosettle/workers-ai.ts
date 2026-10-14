// Ask the local auto-settle Worker (workers-ai/, run with wrangler dev) how a hold should be settled (#19).

import type { Hold, Pick } from "./jev.ts";
import { refused, ruled } from "./rules.ts";

export const WORKER = process.env.AUTOSETTLE_WORKER ?? "http://127.0.0.1:8845";

export interface ModelVerdict {
	readonly pick: Pick;
	readonly confidence: number;
	readonly reason: string;
	readonly model: string;
	/** Round trip from here, through wrangler dev, to Workers AI and back. */
	readonly ms: number;
	/** The model's own time, as the Worker measured it. */
	readonly modelMs: number;
	readonly inputTokens: number;
	/** rule: code decided without the model. turned down: the model's pick would break the file, so an agent settles. */
	readonly by: "rule" | "model" | "turned down";
	/** The model's own pick, when it was turned down. */
	readonly modelPick?: Pick;
}

/** Code's rules first, then the model, then code's check on what the model picked. */
export async function askWorkersAi(
	h: Hold,
	opts: { model?: string; url?: string; samples?: number } = {},
): Promise<ModelVerdict> {
	const rule = ruled(h);
	if (rule) return { ...rule, confidence: 1, model: "rule", ms: 0, modelMs: 0, inputTokens: 0, by: "rule" };
	const v = await askModel(h, opts);
	const no = refused(h, v.pick);
	return no ? { ...v, pick: "agent", reason: no, by: "turned down", modelPick: v.pick } : v;
}

async function askModel(h: Hold, opts: { model?: string; url?: string; samples?: number }): Promise<ModelVerdict> {
	const started = performance.now();
	const res = await fetch(opts.url ?? WORKER, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			hold: h,
			...(opts.model ? { model: opts.model } : {}),
			samples: opts.samples ?? Number(process.env.AUTOSETTLE_SAMPLES ?? 1),
		}),
	});
	const out = (await res.json()) as {
		pick?: Pick;
		confidence?: number;
		reason?: string;
		model: string;
		ms: number;
		error?: string;
		usage?: { prompt_tokens?: number } | null;
	};
	if (!res.ok || out.error || !out.pick) throw new Error(`Workers AI: ${out.error ?? res.status}`);
	return {
		pick: out.pick,
		confidence: Math.min(1, Math.max(0, out.confidence ?? 0)),
		reason: out.reason ?? "",
		model: out.model,
		ms: performance.now() - started,
		modelMs: out.ms,
		inputTokens: out.usage?.prompt_tokens ?? 0,
		by: "model",
	};
}
