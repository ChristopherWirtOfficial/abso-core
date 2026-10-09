// The merge queue's checker loop (#39): one round takes a batch from the
// front of the queue, runs the project's check on shared with the batch on
// top, and lands it or finds the publish that turned it red. The check itself
// is behind an interface (Cloud's CI box in the Worker, a function in tests),
// so this file holds only the rules agreed on #39:
//
// - A batch is everything waiting, in order, up to `cap` (8).
// - Pass: every publish in the batch lands, each as its own version.
// - Fail: halve prefixes to find the passing prefix and the first publish
//   that fails on top of it. That failing prefix is run once more; only a
//   second failure pulls the publish. The passing prefix lands at once.
// - A timeout is a check failure. A box failure (never started, box lost,
//   no exit code) pulls nobody: the run is retried once, then the queue pauses.
// - While shared is red, prefixes are tried one publish longer at a time,
//   and the first that passes lands: it holds the fix, with whatever came
//   before it. Nobody is pulled, since on a red base every prefix fails.
import type { Blobs, Modes, PullReason } from "./project.ts";

export interface Candidate {
	readonly ids: number[];
	readonly files: Record<string, string>;
	readonly modes: Modes;
	readonly blobs: Blobs;
	readonly tree: string;
}

export type CheckResult =
	| { readonly kind: "pass" }
	/** The check failed or ran past its limit. `output` is its end, for the publisher. */
	| { readonly kind: "fail"; readonly output?: string }
	/** The box failed: the run never started, the box was lost, or there was no exit code. */
	| { readonly kind: "box"; readonly reason: string };

export interface Checker {
	check(candidate: Candidate): Promise<CheckResult>;
}

/** The engine calls the loop needs: Project has them all. */
export interface QueueEngine {
	queue(): { items: { id: number }[] };
	queueChecking(n: number): number[];
	queueCandidate(n: number): Candidate;
	queueLand(n: number, time: number): { versions: { id: number; version: number }[] };
	queuePull(id: number, reason: Exclude<PullReason, "depends">, time: number, output?: string): { pulled: number[] };
}

export interface RoundOptions {
	/** The most publishes in one batch. */
	readonly cap?: number;
	/** Whether shared's newest version fails the check now. */
	readonly sharedRed?: boolean;
	readonly now?: () => number;
}

export type RoundResult =
	| { readonly kind: "idle" }
	| { readonly kind: "landed"; readonly versions: { id: number; version: number }[]; readonly checks: number }
	| {
			readonly kind: "pulled";
			readonly versions: { id: number; version: number }[];
			readonly pulled: number[];
			readonly output?: string;
			readonly checks: number;
	  }
	/** Shared is red and no prefix of the batch made it pass: nothing landed, nobody pulled. */
	| { readonly kind: "held"; readonly checks: number; readonly output?: string }
	/** The box failed twice in a row: nothing landed, nobody pulled. */
	| { readonly kind: "paused"; readonly reason: string; readonly checks: number }
	/**
	 * Shared changed while the box checked (a drop, or a push with plain git),
	 * so what it checked isn't what would land: nothing landed, nobody pulled.
	 * Run the round again.
	 */
	| { readonly kind: "moved"; readonly checks: number };

class Moved extends Error {}

class Paused extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

/** Run one round of the queue. Call it again while it answers `landed` or `pulled` and the queue isn't empty. */
export async function queueRound(
	engine: QueueEngine,
	checker: Checker,
	options: RoundOptions = {},
): Promise<RoundResult> {
	const waiting = engine.queue().items.length;
	if (waiting === 0) return { kind: "idle" };
	const now = options.now ?? Date.now;
	const n = Math.min(Math.max(1, options.cap ?? 8), waiting);
	let checks = 0;
	let output: string | undefined;
	/** The tree each prefix was checked as: a land or a pull goes ahead only on that same tree (Git Lessons' review). */
	const checked = new Map<number, string>();
	const same = (k: number): void => {
		if (engine.queueCandidate(k).tree !== checked.get(k)) throw new Moved();
	};
	const land = (k: number) => {
		same(k);
		return engine.queueLand(k, now()).versions;
	};
	/** Whether shared with the first `k` queued on top passes; a box failure is retried once. */
	const passes = async (k: number): Promise<boolean> => {
		let last: CheckResult | undefined;
		for (let tries = 0; tries < 2; tries++) {
			checks++;
			const candidate = engine.queueCandidate(k);
			checked.set(k, candidate.tree);
			last = await checker.check(candidate);
			if (last.kind !== "box") break;
		}
		if (last!.kind === "box") throw new Paused(last!.reason);
		if (last!.kind === "fail") output = last!.output;
		return last!.kind === "pass";
	};
	engine.queueChecking(n);
	try {
		if (options.sharedRed) {
			for (let k = 1; k <= n; k++) if (await passes(k)) return { kind: "landed", versions: land(k), checks };
			return { kind: "held", checks, ...(output !== undefined ? { output } : {}) };
		}
		if (await passes(n)) return { kind: "landed", versions: land(n), checks };
		// Shared alone passes; shared plus all n fails. Find the longest passing prefix.
		let good = 0;
		let bad = n;
		while (bad - good > 1) {
			const mid = Math.floor((good + bad) / 2);
			if (await passes(mid)) good = mid;
			else bad = mid;
		}
		// The failing prefix fails twice before anyone is pulled.
		if (await passes(bad)) return { kind: "landed", versions: land(bad), checks };
		const culprit = engine.queue().items[bad - 1]!.id;
		same(bad);
		const versions = good > 0 ? land(good) : [];
		const { pulled } = engine.queuePull(culprit, "failed", now(), output);
		return { kind: "pulled", versions, pulled, checks, ...(output !== undefined ? { output } : {}) };
	} catch (e) {
		if (e instanceof Paused) return { kind: "paused", reason: e.reason, checks };
		if (e instanceof Moved) return { kind: "moved", checks };
		throw e;
	} finally {
		engine.queueChecking(0);
	}
}
