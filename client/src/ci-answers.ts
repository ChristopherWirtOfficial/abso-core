// What the server answers about its checks (#39): CI's state, one version's job, and the merge queue.

/** One publish waiting in the merge queue (#39). */
export interface QueueItem {
	readonly id: number;
	readonly agent: string;
	readonly message: string;
	readonly time: number;
	readonly changes: number;
	/** In the batch being checked now. */
	readonly checking: boolean;
}
/** The last round of the merge queue: what landed, what was pulled, or why nothing moved. */
export type QueueRound =
	| { readonly kind: "idle" }
	| {
			readonly kind: "landed";
			readonly versions: readonly { readonly id: number; readonly version: number }[];
			readonly checks: number;
	  }
	| {
			readonly kind: "pulled";
			readonly versions: readonly { readonly id: number; readonly version: number }[];
			readonly pulled: readonly number[];
			readonly output?: string;
			readonly checks: number;
	  }
	| { readonly kind: "held"; readonly checks: number; readonly output?: string }
	| { readonly kind: "paused"; readonly reason: string; readonly checks: number };
/** The merge queue now (#39): `GET /queue`, and status's `queue` while anything waits or it's paused. */
export interface QueueState {
	readonly items: readonly QueueItem[];
	/** A round is running. */
	readonly checking: boolean;
	/** The box failed twice: nothing moves until the next try (ISO times). */
	readonly paused: { readonly reason: string; readonly since: string; readonly nextTry: string } | null;
	readonly last: (QueueRound & { readonly at: string }) | null;
}
/** CI's state for the project (#39): status's `ci`, and `GET /ci` without a version. */
export interface CiStatus {
	/** The newest version whose own job passed with a build, and its /latest link. */
	readonly latest: { readonly version: number; readonly url?: string } | null;
	readonly checked: { readonly version: number; readonly result: CiResult } | null;
	readonly running: {
		readonly version: number /** ISO time. */;
		readonly since: string;
		readonly bisect?: boolean;
	} | null;
	/** Set while shared fails: the first failing version (agent and message null while bisecting, or when it never passed). */
	readonly red: {
		readonly version: number;
		readonly agent: string | null;
		readonly message: string | null;
		readonly lastGood: number | null;
		readonly bisecting?: boolean;
	} | null;
	/** How many versions shared is ahead of `latest`. */
	readonly behind: number | null;
	readonly waiting?: { readonly reason: string /** ISO time. */; readonly until: string };
	/** The newest job didn't run (nothing to run, the box failed twice): versions from..version weren't checked and aren't queued. */
	readonly skipped?: {
		readonly version: number;
		readonly from: number;
		readonly reason: string /** ISO time. */;
		readonly at: string;
	} | null;
}
/** A job's result; `none` when it never ran (a box failure twice, or nothing to run). */
export type CiResult = "pass" | "fail" | "none";
/** A shared version's mark in the log. */
export type CiMark = "pass" | "fail" | "running" | "waiting" | "not checked";
/** One version's job (#39): `GET /ci?version=N`. A version without its own job has only a result. */
export interface CiJob {
	readonly version: number;
	readonly result: CiResult | "running" | "waiting" | "not checked";
	/** The failing step: setup, build, check, abso.json or box. */
	readonly step?: string;
	readonly exit?: number | null;
	readonly seconds?: number;
	readonly cold?: boolean;
	/** The oldest version the job stood in for. */
	readonly from?: number;
	readonly bisect?: boolean;
	readonly built?: boolean;
	/** The job's last 4 KB. */
	readonly output?: string;
	/** ISO time. */
	readonly at?: string;
}
