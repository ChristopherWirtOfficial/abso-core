// abso autosettle (abso-core 23): see or change what the project's server does with a held push: Off, Advise or Settle.
// The model only picks a side; under Settle, the held agent's own abso settles and pushes again.
import { ApiError } from "./api-error.ts";
import { type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open } from "./commands.ts";

export type AutosettleMode = "off" | "advise" | "settle";
const MODES: readonly AutosettleMode[] = ["off", "advise", "settle"];

/** The project's choice, as the server answers it. */
export interface AutosettleAnswer {
	readonly project: string;
	readonly mode: AutosettleMode;
	readonly at: number;
	readonly changedBy?: string;
	readonly changedAt?: string;
	readonly gate?: "open" | "stopped";
}

/** A server with no choice per project (the open server): its operator's AUTOSETTLE decides. */
const NO_CHOICE_HERE =
	"This server keeps no auto-settle choice per project: whoever runs it sets AUTOSETTLE (off, on for advice, act to settle).";

export function autosettleWords(a: AutosettleAnswer): string {
	const what =
		a.mode === "off"
			? "Off: held pushes come back as they always have."
			: a.mode === "advise"
				? "Advise: each collision in a held push comes back with the model's pick, how sure it is, and why. The agent still settles."
				: `Settle at ${a.at.toFixed(2)}: when the model is at least that sure about every collision in a held push, the agent's abso settles it and pushes again. Anything less sure is left to the agent, with the advice.`;
	return [
		`${a.project} is on ${what}`,
		...(a.gate === "stopped" ? ["Stopped by abso for now: no held push gets advice until it starts again."] : []),
		...(a.changedBy ? [`Last changed by ${a.changedBy}${a.changedAt ? `, ${a.changedAt}` : ""}.`] : []),
	].join("\n");
}

/** One held push in the history, as the server answers it. */
interface HistoryHold {
	readonly id: number;
	readonly time: string;
	readonly agent: string;
	readonly message: string;
	readonly mode: AutosettleMode;
	readonly at: number;
	readonly collisions: readonly {
		readonly file: string;
		readonly theirs: { readonly agent: string; readonly version?: number };
		readonly advice: {
			readonly pick: string;
			readonly confidence: number;
			readonly by: string;
			readonly reason: string;
		};
		readonly settled: boolean;
		readonly outcome: { readonly kept: string; readonly auto: boolean; readonly version?: number } | null;
		readonly calls?: readonly { readonly model: string; readonly input: unknown; readonly output: unknown }[];
	}[];
}

/** A held push in a few lines: what the model said, and what was then kept. */
export function holdWords(h: HistoryHold): string {
	return [
		`${h.id}: ${h.agent}, ${h.time}, under ${h.mode}${h.mode === "settle" ? ` at ${h.at.toFixed(2)}` : ""}: "${h.message.split(/\r?\n/)[0]}"`,
		...h.collisions.map((c) => {
			const said = `${c.advice.pick === "agent" ? "leave it to an agent" : `keep ${c.advice.pick}`} (${c.advice.by === "rule" ? "a check in code" : `${c.advice.by}, ${c.advice.confidence.toFixed(2)}`})`;
			const then = c.outcome
				? `kept ${c.outcome.kept}${c.outcome.auto ? " automatically" : " by hand"}${c.outcome.version !== undefined ? ` in version ${c.outcome.version}` : ""}`
				: "not settled yet";
			return `  ${c.file}, against ${c.theirs.agent}${c.theirs.version !== undefined ? `'s version ${c.theirs.version}` : ""}: advised ${said}${c.settled ? ", told to settle" : ""}; ${then}.`;
		}),
	].join("\n");
}

/** abso autosettle history [<id>]: the held pushes the model advised on, newest first, or one with its calls. */
async function runHistory(args: Parsed, env: Env): Promise<Output> {
	const { api } = open(env);
	const id = args.positionals[1];
	if (id !== undefined) {
		if (!/^[0-9]{1,9}$/.test(id)) throw new UsageError("abso autosettle history <id> takes a hold's number");
		const hold = (await api.autosettleHold(Number(id))) as HistoryHold;
		const calls = hold.collisions.flatMap((c) => (c.calls ?? []).map((k) => `  ${c.file}: ${k.model}`));
		return {
			text: [holdWords(hold), "Calls to the model (--json has each request and answer):", ...calls].join("\n"),
			json: { ...hold },
		};
	}
	const page = (await api.autosettleHistory()) as { holds: HistoryHold[]; next?: number };
	return {
		text:
			page.holds.length === 0
				? "No held push has had advice in this project yet."
				: page.holds.map(holdWords).join("\n"),
		json: { ...page },
	};
}

export async function runAutosettle(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals[0] === "history") {
		if (args.positionals.length > 2) throw new UsageError("abso autosettle history takes at most a hold's number");
		return runHistory(args, env);
	}
	if (args.positionals.length > 1) throw new UsageError("autosettle takes at most one word: off, advise or settle");
	const want = args.positionals[0];
	const atRaw = str(args, "at");
	const { api } = open(env);
	try {
		if (want === undefined) {
			if (atRaw !== undefined)
				throw new UsageError("--at goes with a choice, for example: abso autosettle settle --at 0.6");
			const now = await api.autosettle();
			return { text: autosettleWords(now), json: { ...now } };
		}
		if (!MODES.includes(want as AutosettleMode))
			throw new UsageError("autosettle is off, advise or settle, for example: abso autosettle settle --at 0.6");
		const at = atRaw === undefined ? undefined : Number(atRaw);
		if (at !== undefined && !(at >= 0.3 && at <= 0.95))
			throw new UsageError("--at is how sure the model must be before abso settles: a number from 0.3 to 0.95");
		const set = await api.setAutosettle(want as AutosettleMode, at);
		return { text: autosettleWords(set), json: { ...set } };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404 && /no such route/.test(e.message))
			return { text: NO_CHOICE_HERE, json: { error: NO_CHOICE_HERE } };
		throw e;
	}
}
