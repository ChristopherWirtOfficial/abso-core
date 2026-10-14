// A Worker that asks a Workers AI text model how a held push's collision should
// be settled (#19). JSON mode limits the answer to abso's settle choices, a
// confidence and a one-line reason: the model picks, it never writes code.
//
//   cd scripts/autosettle/workers-ai && npx wrangler dev --port 8845   (the AI binding always runs on Cloudflare)
//   POST / with {"hold": <Hold>, "model"?: "<@cf/... model>"}

interface Env {
	readonly AI: { run(model: string, input: unknown): Promise<unknown> };
}

interface Hold {
	readonly file: string;
	readonly base: readonly string[];
	readonly yours: readonly string[];
	readonly theirs: readonly string[];
	readonly before: readonly string[];
	readonly after: readonly string[];
	readonly yourMessage?: string;
	readonly yourAgent?: string;
	readonly theirMessage?: string;
	readonly theirAgent?: string;
	readonly issue?: string;
}

const PICKS = ["yours", "theirs", "both", "agent"] as const;
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM = `You settle merge collisions in a version control system for coding agents.
Two agents changed the same lines of one file. Both started from BEFORE. YOURS is what the held agent wrote, for the reason in its push message; THEIRS was pushed first, for the reason in its push message.
Pick exactly one:
- "yours": keep YOURS only. YOURS already does what THEIRS meant, or THEIRS is wrong or out of date.
- "theirs": keep THEIRS only. THEIRS already does what YOURS meant, or YOURS is wrong or out of date.
- "both": keep both unchanged, YOURS then THEIRS. They add separate things that work side by side, with nothing duplicated or contradictory.
- "agent": none of those is correct. The sides change the same thing in different ways (such as two different values for one setting), or keeping both would duplicate or contradict, so a correct result needs a hand edit.
Give "confidence" from 0 to 1: how likely your pick is the correct settle. Give "reason" as one plain sentence. Do not write code.`;

const block = (lines: readonly string[]) => (lines.length === 0 ? "(no lines)" : lines.join("\n"));

function prompt(h: Hold): string {
	return [
		`FILE: ${h.file}`,
		`YOUR PUSH (${h.yourAgent ?? "you"}): ${h.yourMessage ?? "(no message)"}`,
		`THEIR PUSH (${h.theirAgent ?? "the other agent"}): ${h.theirMessage ?? "(no message)"}`,
		...(h.issue ? [`ISSUE: ${h.issue}`] : []),
		"",
		"LINES ABOVE:",
		block(h.before),
		"",
		"BEFORE (what both started from):",
		block(h.base),
		"",
		"YOURS:",
		block(h.yours),
		"",
		"THEIRS:",
		block(h.theirs),
		"",
		"LINES BELOW:",
		block(h.after),
	].join("\n");
}

const SCHEMA = {
	type: "object",
	properties: {
		pick: { type: "string", enum: PICKS },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
	},
	required: ["pick", "confidence", "reason"],
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") return new Response("POST a hold", { status: 405 });
		const { hold, model = DEFAULT_MODEL } = (await request.json()) as { hold: Hold; model?: string };
		const started = Date.now();
		try {
			const out = (await env.AI.run(model, {
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: prompt(hold) },
				],
				response_format: { type: "json_schema", json_schema: SCHEMA },
				temperature: 0,
				max_tokens: 200,
			})) as { response: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
			const answer = (typeof out.response === "string" ? JSON.parse(out.response) : out.response) as {
				pick: string;
				confidence: number;
				reason: string;
			};
			if (!(PICKS as readonly string[]).includes(answer.pick))
				return Response.json({ error: `not a settle choice: ${answer.pick}` }, { status: 502 });
			return Response.json({ ...answer, model, ms: Date.now() - started, usage: out.usage ?? null });
		} catch (e) {
			return Response.json({ error: (e as Error).message, model, ms: Date.now() - started }, { status: 502 });
		}
	},
};
