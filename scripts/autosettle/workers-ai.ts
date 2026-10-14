// Ask the local auto-settle Worker (workers-ai/, run with wrangler dev) how a hold should be settled (#19).

import type { Hold, Pick } from "./jev.ts";

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
}

export async function askWorkersAi(h: Hold, opts: { model?: string; url?: string } = {}): Promise<ModelVerdict> {
	const started = performance.now();
	const res = await fetch(opts.url ?? WORKER, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ hold: h, ...(opts.model ? { model: opts.model } : {}) }),
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
	};
}
