// The merge queue on the client (#39): with "queue": true in avcs.json, a
// publish to shared waits in the queue until a batch with it passes the
// project's check, and lands, or is pulled with the check's output. publish
// waits for that, up to a cap under the chat's 2-minute command limit; status
// shows the queue; abso unqueue takes a queued publish back.

import { type Api, newsLines, type QueueItem, type QueueState } from "./api.ts";
import { type Parsed, UsageError } from "./args.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { logNews } from "./folder.ts";

/** How long publish waits by default: under the 2 minutes a Claude Code shell command gets (#39, agreed with Engine). */
export const WAIT_SECONDS = 100;

/** Exit code for a publish still in the queue when the wait ends (#39). */
export const STILL_QUEUED = 3;

export type QueueOutcome =
	| { readonly kind: "landed"; readonly version: number; readonly news: string[] }
	| { readonly kind: "pulled"; readonly text: string; readonly news: string[] }
	/** Out of the queue, but neither the last round nor the news says how (another round ran since, or the news was taken). */
	| { readonly kind: "gone"; readonly news: string[] }
	| { readonly kind: "waiting"; readonly state: QueueState | undefined };

/** Where a queued publish stands: being checked, or how many wait ahead of it. */
export function standing(items: readonly QueueItem[], id: number): string {
	const at = items.findIndex((q) => q.id === id);
	if (at < 0) return "out of the queue";
	if (items[at]!.checking) {
		const batch = items.filter((q) => q.checking).length;
		return batch === 1 ? "being checked" : `being checked in a batch of ${batch}`;
	}
	return at === 0 ? "next to be checked" : `waiting, ${at} ${at === 1 ? "publish" : "publishes"} ahead of it`;
}

/**
 * Wait for queued publish `id` to land or be pulled, polling the queue every
 * `pollMs` until `waitMs` has passed. A failed poll isn't a failed publish:
 * it tries again until the time is up. The outcome comes from the last
 * round, else from the news that says it (which is taken, so it's handed back
 * to print).
 */
export async function waitForQueued(
	api: Api,
	id: number,
	waitMs: number,
	say: (line: string) => void,
	pollMs = 3000,
): Promise<QueueOutcome> {
	const until = Date.now() + waitMs;
	let state: QueueState | undefined;
	let said = "";
	while (Date.now() < until) {
		await new Promise((ok) => setTimeout(ok, Math.min(pollMs, Math.max(0, until - Date.now()))));
		try {
			state = await api.queueState();
		} catch {
			continue;
		}
		if (!state.items.some((q) => q.id === id)) return outcomeOf(api, id, state);
		const now = state.paused
			? `the queue is paused: ${state.paused.reason}; next try ${state.paused.nextTry.slice(11, 16)} UTC`
			: standing(state.items, id);
		if (now !== said) say(`abso: your publish is ${now}.\n`);
		said = now;
	}
	return { kind: "waiting", state };
}

async function outcomeOf(api: Api, id: number, state: QueueState): Promise<QueueOutcome> {
	const all = await api.news().then(
		(a) => newsLines(a.news),
		() => [] as string[],
	);
	// The news names the outcome; one publish per agent is the usual case, so the newest such line is ours.
	// publish says the outcome itself, so that line isn't printed again as news.
	const said = [...all]
		.reverse()
		.find((n) => /^Your queued publish ".*" (landed as version \d+|was pulled: )/s.test(n));
	const news = all.filter((n) => n !== said);
	const last = state.last;
	const landed =
		last && (last.kind === "landed" || last.kind === "pulled") ? last.versions.find((v) => v.id === id) : undefined;
	if (landed) return { kind: "landed", version: landed.version, news };
	const version = said === undefined ? undefined : /landed as version (\d+)\.$/.exec(said)?.[1];
	if (version !== undefined) return { kind: "landed", version: Number(version), news };
	if (said !== undefined) return { kind: "pulled", text: said, news };
	if (last?.kind === "pulled" && last.pulled.includes(id))
		return {
			kind: "pulled",
			text: `Your queued publish was pulled: the project's check failed on it.${last.output ? `\n${last.output.trimEnd()}` : ""}`,
			news,
		};
	return { kind: "gone", news };
}

/**
 * A pull, said for the publisher (#39, agreed with Engine): the check's output
 * first, then the verdict as the last line, since that's the line an agent
 * acts on. The engine's news has the output in the middle of its sentence.
 */
export function pulledText(news: string): string {
	const m =
		/^Your queued publish (".*") was pulled: ([^\n]*?)(?::\n([\s\S]*?))?\.? Its changes are still in your draft\.$/s.exec(
			news.replace(/\n\. Its changes/, ". Its changes"),
		);
	if (!m) return `${news}\nNot published. Fix it, then publish again.`;
	const output = m[3]?.trimEnd() ?? "";
	return [
		...(output === "" ? [] : ["The check's output ends:", output]),
		`Not published: your queued publish ${m[1]} was pulled: ${m[2]!.replace(/\.$/, "")}. Its changes are still in your draft; fix them, then publish again.`,
	].join("\n");
}

/** The lines status shows about the queue: who waits, what is being checked, a pause. Nothing while it's empty. */
export function queueText(queue: QueueState | null | undefined, me: string): string[] {
	if (!queue) return [];
	const lines: string[] = [];
	if (queue.items.length > 0) {
		const checking = queue.items.filter((q) => q.checking);
		const waiting = queue.items.filter((q) => !q.checking);
		const who = (q: QueueItem) => `${q.agent === me ? `yours (${q.id})` : q.agent}`;
		lines.push(
			`Merge queue: ${[
				checking.length > 0
					? `checking ${checking.length === 1 ? who(checking[0]!) : `a batch of ${checking.length} (${checking.map(who).join(", ")})`}`
					: "",
				waiting.length > 0 ? `waiting: ${waiting.map(who).join(", ")}` : "",
			]
				.filter((p) => p !== "")
				.join("; ")}.`,
		);
	}
	if (queue.paused)
		lines.push(
			`The merge queue is paused since ${queue.paused.since.slice(11, 16)} UTC: ${queue.paused.reason}; next try ${queue.paused.nextTry.slice(11, 16)} UTC.`,
		);
	return lines;
}

/** abso unqueue: take this agent's queued publishes back; their changes stay in the draft. */
export async function runUnqueue(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 0)
		throw new UsageError("unqueue takes no arguments: it takes back every publish of yours still in the merge queue");
	const { root, api } = open(env);
	const answer = await api.unqueue();
	// The engine says it as news too ("you withdrew it"); this command's own text says the same, so it isn't printed twice.
	const news = await api.news().then(
		(a) => newsLines(a.news),
		() => [] as string[],
	);
	logNews(root, news);
	const others = news.filter((n) => !/^Your queued publish ".*" was pulled: you withdrew it\./s.test(n));
	const ids = answer.pulled;
	return {
		text: [
			`Took back ${ids.length === 1 ? `queued publish ${ids[0]}` : `queued publishes ${ids.join(", ")}`}: ${ids.length === 1 ? "its" : "their"} changes are still in your draft, unpublished.`,
			...others.map((n) => `  ${n}`),
		].join("\n"),
		json: { pulled: ids, news: others },
	};
}
