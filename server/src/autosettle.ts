// A first opinion on a held push (#19): for each collision, which of abso's
// settle choices fits, from Workers AI, with checks in code before and after.
// Off unless AUTOSETTLE is "on" and the Worker has an AI binding. The model
// picks one of four words; it never writes code.

/** abso's settle choices, plus a hand edit by an agent. */
export type Pick = "yours" | "theirs" | "both" | "agent";
export const PICKS: readonly Pick[] = ["yours", "theirs", "both", "agent"];
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** One collision as the held agent sees it. */
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

export interface Advice {
	readonly pick: Pick;
	/** The share of samples that agree, or 1 for a pick code made. */
	readonly confidence: number;
	readonly reason: string;
	/** rule: code decided without the model. turned down: the model's pick would break the file. */
	readonly by: "rule" | "model" | "turned down";
	readonly modelPick?: Pick;
	readonly model?: string;
	readonly ms: number;
}

export interface Ai {
	run(model: string, input: unknown): Promise<unknown>;
}

const solid = (lines: readonly string[]) => lines.map((l) => l.trim()).filter((l) => /[A-Za-z0-9]/.test(l));

/** A pick code can make without the model, with why; undefined when it takes judgment. */
export function ruled(h: Hold): { pick: Pick; reason: string } | undefined {
	const yours = solid(h.yours);
	const theirs = solid(h.theirs);
	if (yours.join("\n") === theirs.join("\n")) return { pick: "theirs", reason: "both sides wrote the same lines" };
	if (yours.length > 0 && yours.every((l) => theirs.includes(l)))
		return { pick: "theirs", reason: "every line of yours is already in theirs" };
	if (theirs.length > 0 && theirs.every((l) => yours.includes(l)))
		return { pick: "yours", reason: "every line of theirs is already in yours" };
	return undefined;
}

/** Why a model's pick can't be applied as it is, or undefined when it can. */
export function refused(h: Hold, pick: Pick): string | undefined {
	if (pick !== "both") return undefined;
	const theirs = new Set(solid(h.theirs));
	const twice = solid(h.yours).filter((l) => theirs.has(l));
	if (twice.length > 0)
		return `keeping both would repeat ${twice.length === 1 ? "a line" : `${twice.length} lines`}: ${twice[0]}`;
	// The same key or name set on both sides: `timeoutMs:`, `limit =`.
	const key = (l: string) => /^([A-Za-z_$"'][\w$"'-]*)\s*[:=]/.exec(l)?.[1];
	const theirKeys = new Set(solid(h.theirs).map(key).filter(Boolean));
	const clash = solid(h.yours)
		.map(key)
		.find((k) => k && theirKeys.has(k));
	if (clash) return `keeping both would set ${clash} twice`;
	// Two versions of one statement, such as an import from the same module with a different list of names:
	// most of the names on one side are on the other too.
	const names = (lines: readonly string[]) => new Set(lines.join(" ").match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
	const a = names(h.yours);
	const b = names(h.theirs);
	const shared = [...a].filter((n) => b.has(n)).length;
	const share = shared / Math.max(1, Math.min(a.size, b.size));
	return share >= 0.5
		? `keeping both would repeat one statement in two versions (${shared} names on both sides)`
		: undefined;
}

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
		h.base.length === 0 && h.before.length === 0 ? "(not given)" : block(h.base),
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

/** The model's pick: several samples at once, the confidence being the share that agree with the most common pick. */
export async function modelPick(
	ai: Ai,
	h: Hold,
	opts: { model?: string; samples?: number } = {},
): Promise<{ pick: Pick; confidence: number; reason: string; selfReported: number[]; usage: unknown }> {
	const model = opts.model ?? MODEL;
	const samples = Math.min(9, Math.max(1, opts.samples ?? 5));
	const one = async () => {
		const out = (await ai.run(model, {
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: prompt(h) },
			],
			response_format: { type: "json_schema", json_schema: SCHEMA },
			temperature: samples > 1 ? 0.7 : 0,
			max_tokens: 200,
		})) as { response: unknown; usage?: unknown };
		const answer = (typeof out.response === "string" ? JSON.parse(out.response) : out.response) as {
			pick: string;
			confidence: number;
			reason: string;
		};
		if (!(PICKS as readonly string[]).includes(answer?.pick)) throw new Error(`not a settle choice: ${answer?.pick}`);
		return { ...answer, pick: answer.pick as Pick, usage: out.usage ?? null };
	};
	const answers = await Promise.all(Array.from({ length: samples }, one));
	const votes = Object.fromEntries(PICKS.map((p) => [p, answers.filter((a) => a.pick === p).length])) as Record<
		Pick,
		number
	>;
	const pick = PICKS.reduce((a, b) => (votes[b] > votes[a] ? b : a));
	const first = answers.find((a) => a.pick === pick)!;
	return {
		pick,
		confidence: samples > 1 ? votes[pick] / samples : first.confidence,
		reason: first.reason,
		selfReported: answers.map((a) => a.confidence),
		usage: first.usage,
	};
}

/** Code's rules first, then the model, then code's check on what the model picked. */
export async function advise(ai: Ai, h: Hold, opts: { model?: string; samples?: number } = {}): Promise<Advice> {
	const started = Date.now();
	const rule = ruled(h);
	if (rule) return { ...rule, confidence: 1, by: "rule", ms: 0 };
	const m = await modelPick(ai, h, opts);
	const model = opts.model ?? MODEL;
	const no = refused(h, m.pick);
	return no
		? {
				pick: "agent",
				confidence: m.confidence,
				reason: no,
				by: "turned down",
				modelPick: m.pick,
				model,
				ms: Date.now() - started,
			}
		: { pick: m.pick, confidence: m.confidence, reason: m.reason, by: "model", model, ms: Date.now() - started };
}

interface HeldCollision {
	readonly kind: string;
	readonly file: string;
	readonly untouched?: true;
	readonly marked?: true;
	readonly yours: { readonly lines: [number, number]; readonly text: string };
	readonly theirs: { readonly agent: string; readonly message: string; readonly text: string; readonly file?: string };
}

/**
 * Advice for each lines collision of a held push, in the order of `collisions`; null where it doesn't apply
 * (another kind, already in the agent's file) or the model failed. Collisions don't carry the lines both
 * started from, so the model goes without them.
 */
export async function adviseHeld(
	ai: Ai,
	collisions: readonly HeldCollision[],
	held: { agent: string; message: string },
): Promise<(Advice | null)[]> {
	const lines = (text: string) => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));
	return Promise.all(
		collisions.map(async (c) => {
			if (c.kind !== "lines" || c.untouched || c.marked) return null;
			try {
				return await advise(ai, {
					file: c.file,
					base: [],
					yours: lines(c.yours.text),
					theirs: lines(c.theirs.text),
					before: [],
					after: [],
					yourAgent: held.agent,
					yourMessage: held.message,
					theirAgent: c.theirs.agent,
					theirMessage: c.theirs.message,
				});
			} catch (e) {
				console.error(`autosettle: ${c.file}: ${e instanceof Error ? e.message : String(e)}`);
				return null;
			}
		}),
	);
}
