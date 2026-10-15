// Ask Jev (TypeSafe's System One model) how a held push's collision should be
// settled (#19). Jev answers a Choice with a probability per option, so it can
// pick among abso's own settle choices but can't write code.
//
// API: POST https://api.typesafe.ai/v1/systemone, per https://docs.typesafe.ai/api.md.
// The key comes from JEV_API_KEY (or TYPESAFE_API_KEY, the SDK's own name) and
// is never printed or written anywhere.

import { execFileSync } from "node:child_process";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** abso's settle choices, plus a hand edit by an agent. */
export type Pick = "yours" | "theirs" | "both" | "agent";
export const PICKS: readonly Pick[] = ["yours", "theirs", "both", "agent"];

/** One collision as the held agent sees it: a marker block and what's around it. */
export interface Hold {
	readonly file: string;
	readonly base: readonly string[];
	readonly yours: readonly string[];
	readonly theirs: readonly string[];
	readonly before: readonly string[];
	readonly after: readonly string[];
	/** The held push's message: the settler's reason. */
	readonly yourMessage?: string;
	readonly yourAgent?: string;
	/** The push that got there first: its reason. */
	readonly theirMessage?: string;
	readonly theirAgent?: string;
	readonly issue?: string;
}

export interface Verdict {
	readonly pick: Pick;
	/** Averaged over both option orders. */
	readonly probabilities: Record<Pick, number>;
	/** Choice confidence on the averaged probabilities: 0 at an even split, 1 when certain. */
	readonly confidence: number;
	/** Each order's own answer, to see whether the order moved it. */
	readonly orders: readonly { pick: Pick; probabilities: Record<Pick, number>; confidence: number }[];
	/** Yes-probabilities of the side questions. */
	readonly signs: Record<string, number>;
	readonly model: string;
	readonly ms: number;
	readonly inputTokens: number;
}

export function apiKey(): string {
	const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? userVariable("JEV_API_KEY");
	if (!key) throw new Error("No Jev key: set JEV_API_KEY in the environment.");
	return key;
}

/** On Windows, a user variable set after this shell started (setx, or the Environment Variables dialog). */
function userVariable(name: string): string | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const out = execFileSync(
			"powershell.exe",
			["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

const text = (lines: readonly string[]): string => (lines.length === 0 ? "(no lines)" : lines.join("\n"));

function stateOf(h: Hold): Record<string, unknown> {
	return {
		file: h.file,
		lines_above: text(h.before),
		before_either_change: text(h.base),
		yours: text(h.yours),
		theirs: text(h.theirs),
		lines_below: text(h.after),
		your_push: { agent: h.yourAgent ?? "you", message: h.yourMessage ?? "(no message)" },
		their_push: { agent: h.theirAgent ?? "the other agent", message: h.theirMessage ?? "(no message)" },
		...(h.issue ? { issue: h.issue } : {}),
	};
}

const INSTRUCTIONS =
	"Two agents changed the same lines of `file`. Both started from `before_either_change`. " +
	"`yours` is what the held agent wrote, for the reason in `your_push`; `theirs` was pushed first, for the reason in `their_push`. " +
	"The region sits between `lines_above` and `lines_below`. " +
	"Which result is correct code that does what both pushes meant?";

const CRITERIA: Record<Pick, string> = {
	yours: "Keep `yours` only: `yours` already does what `theirs` meant, or `theirs` is wrong or out of date.",
	theirs: "Keep `theirs` only: `theirs` already does what `yours` meant, or `yours` is wrong or out of date.",
	both: "Keep both unchanged, `yours` then `theirs`: they add separate things that work side by side, and nothing is duplicated or contradicts.",
	agent:
		"Neither side alone and not both unchanged: the sides change the same thing in different ways (such as two different values for one setting), or keeping both would duplicate or contradict, so a correct result needs a hand edit.",
};

function choice(order: readonly Pick[]) {
	return {
		type: "choice",
		instructions: INSTRUCTIONS,
		criteria: Object.fromEntries(order.map((p) => [p, CRITERIA[p]])),
	};
}

const SIGNS: Record<string, string> = {
	same_setting_different_values:
		"Do `yours` and `theirs` set the same setting, constant or value to two different values?",
	theirs_covers_yours: "Does `theirs` already do everything `yours` was changed to do?",
	yours_covers_theirs: "Does `yours` already do everything `theirs` was changed to do?",
	both_unchanged_compiles:
		"If `yours` were placed directly above `theirs`, unchanged, would the file still be correct code with nothing defined twice?",
};

function confidenceOf(p: Record<Pick, number>): number {
	const max = Math.max(...PICKS.map((k) => p[k]));
	const even = 1 / PICKS.length;
	return Math.max(0, (max - even) / (1 - even));
}

function top(p: Record<Pick, number>): Pick {
	return PICKS.reduce((a, b) => (p[b] > p[a] ? b : a));
}

/**
 * One System One request (TypeSafe's API, which Cloudflare's Clef also takes): the choice in two option orders
 * (Jev's docs warn order can sway a Choice) and the side questions.
 */
export function systemOneBody(h: Hold, model: string) {
	return {
		model,
		state: stateOf(h),
		questions: {
			settle: choice(PICKS),
			settle_reversed: choice([...PICKS].reverse()),
			...Object.fromEntries(Object.entries(SIGNS).map(([id, q]) => [id, { type: "noul", instructions: q }])),
		},
	};
}

export interface SystemOneAnswer {
	model: string;
	answers: Record<string, { type: string; probabilities?: Record<string, number>; noul?: number; choice?: string }>;
	usage?: { input_tokens?: number };
}

/** Ask Jev once. */
export async function ask(h: Hold, opts: { model?: string; key?: string } = {}): Promise<Verdict> {
	const started = performance.now();
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { authorization: `Bearer ${opts.key ?? apiKey()}`, "content-type": "application/json" },
		body: JSON.stringify(systemOneBody(h, opts.model ?? "jev-latest")),
	});
	const ms = performance.now() - started;
	if (!res.ok) throw new Error(`Jev answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
	return verdictOf((await res.json()) as SystemOneAnswer, ms);
}

/** A System One answer to systemOneBody's questions, as a Verdict. */
export function verdictOf(out: SystemOneAnswer, ms: number): Verdict {
	const orders = ["settle", "settle_reversed"].map((id) => {
		const probabilities = Object.fromEntries(PICKS.map((k) => [k, out.answers[id]!.probabilities![k] ?? 0])) as Record<
			Pick,
			number
		>;
		return { pick: top(probabilities), probabilities, confidence: confidenceOf(probabilities) };
	});
	const probabilities = Object.fromEntries(
		PICKS.map((k) => [k, (orders[0]!.probabilities[k] + orders[1]!.probabilities[k]) / 2]),
	) as Record<Pick, number>;
	return {
		pick: top(probabilities),
		probabilities,
		confidence: confidenceOf(probabilities),
		orders,
		signs: Object.fromEntries(Object.keys(SIGNS).map((id) => [id, out.answers[id]?.noul ?? Number.NaN])),
		model: out.model,
		ms,
		inputTokens: out.usage?.input_tokens ?? 0,
	};
}

/** Dollars for one call: Jev charges $0.042 per million input tokens, output free (docs.typesafe.ai/models). */
export const dollars = (inputTokens: number): number => (inputTokens * 0.042) / 1e6;
