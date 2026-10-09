// What the project's CI says (#39): the server runs avcs.json's setup, build
// and check on each new version of shared. status and log show it; abso ci
// shows it whole, and one version's job with the end of its output.

import { ApiError, type CiJob, type CiMark, type CiStatus } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { when } from "./history.ts";

/** Seconds since an ISO time, as "35 s" or "4 min". */
function ago(iso: string, now: number): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** An ISO time as HH:MM UTC, with the date when it isn't today. */
function clock(iso: string, now: number): string {
	const t = new Date(iso).toISOString();
	return t.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
		? `${t.slice(11, 16)} UTC`
		: `${t.slice(0, 16).replace("T", " ")} UTC`;
}

/** The lines status shows about CI: is shared green or red, and where the preview is. Nothing from a server without CI. */
export function ciText(ci: CiStatus | undefined, shared: number, now = Date.now()): string[] {
	if (ci === undefined) return [];
	const lines: string[] = [];
	const running =
		ci.running === null
			? ""
			: ` Version ${ci.running.version} is being checked (${ago(ci.running.since, now)} so far${ci.running.bisect ? ", a bisect step" : ""}).`;
	const red = ci.red;
	if (red !== null) {
		if (red.bisecting) {
			lines.push(
				`Shared is red: version ${red.version} fails its check, and CI is bisecting for the version that broke it${red.lastGood === null ? "" : ` (version ${red.lastGood} passed)`}.${running}`,
			);
		} else if (red.agent !== null) {
			lines.push(
				`Shared is red since version ${red.version}, by ${red.agent}${red.message === null ? "" : ` ("${red.message}")`}${red.lastGood === null ? "" : `; version ${red.lastGood} was the last to pass`}. abso ci ${red.version} shows why.${running}`,
			);
		} else {
			lines.push(
				`Shared is red: version ${red.version} fails its check${red.lastGood === null ? ", and no version has passed yet" : `; version ${red.lastGood} was the last to pass`}. abso ci ${red.version} shows why.${running}`,
			);
		}
	} else if (ci.checked !== null) {
		const v = ci.checked.version;
		// Newer versions with no job running: skipped (said below) or not reached yet.
		const newer =
			shared > v ? (ci.running !== null ? running : ci.skipped ? "" : ` Versions after ${v} aren't checked yet.`) : "";
		if (ci.checked.result === "pass") lines.push(`Shared is green: version ${v} passed its check.${newer}`);
		else if (ci.checked.result === "fail") lines.push(`Version ${v} failed its check. abso ci ${v} shows why.${newer}`);
		else lines.push(`CI couldn't check version ${v} (the box failed twice, or avcs.json has nothing to run).${newer}`);
	} else {
		lines.push(
			ci.running === null
				? "Not checked yet: CI has not finished a job on this project."
				: `Not checked yet.${running}`,
		);
	}
	// Not running, and not queued either (#39, GAME - CEO: "aren't checked yet" read as queued while CI was off).
	if (ci.skipped) {
		const s = ci.skipped;
		lines.push(
			`CI didn't run ${s.from < s.version ? `versions ${s.from}-${s.version}` : `version ${s.version}`}: ${s.reason}. ${s.from < s.version ? "They" : "It"} won't be checked unless a later version's job covers ${s.from < s.version ? "them" : "it"}.`,
		);
	}
	if (ci.waiting) lines.push(`CI is waiting: ${ci.waiting.reason}; next try ${clock(ci.waiting.until, now)}.`);
	if (ci.latest?.url) {
		const behind =
			ci.behind === null || ci.behind === 0 ? "shared itself" : `${plural(ci.behind, "version")} behind shared`;
		lines.push(
			`Preview of the newest passing build (version ${ci.latest.version}, ${behind}), no token needed: ${ci.latest.url}`,
		);
	}
	return lines;
}

/** A shared version's mark in abso log; "not checked" says nothing, since most versions in a busy hour are covered by a newer one's job. */
export function ciMarkText(mark: CiMark | undefined): string {
	switch (mark) {
		case "pass":
			return ", check passed";
		case "fail":
			return ", check FAILED";
		case "running":
			return ", being checked";
		case "waiting":
			return ", waiting for CI";
		default:
			return "";
	}
}

function jobText(job: CiJob): string[] {
	if (job.result === "running") return [`Version ${job.version} is being checked now.`];
	if (job.result === "waiting") return [`Version ${job.version} isn't checked yet: CI hasn't reached it.`];
	if (job.result === "not checked")
		return [
			`Version ${job.version} had no job of its own: a newer version's job covered it, or none ran. abso bisect checks it in your box.`,
		];
	const covered =
		job.from !== undefined && job.from < job.version ? ` (standing in for versions ${job.from}-${job.version})` : "";
	const took = [
		job.seconds === undefined ? "" : `${job.seconds} s`,
		job.cold ? "cold box" : "",
		job.bisect ? "a bisect step" : "",
	]
		.filter((w) => w !== "")
		.join(", ");
	const head =
		job.result === "pass"
			? `Version ${job.version} passed${covered}${took === "" ? "" : ` (${took})`}${job.built ? "; its build is kept for the preview" : ""}.`
			: job.result === "fail"
				? `Version ${job.version} failed at ${job.step ?? "a step"}${job.exit === undefined || job.exit === null ? "" : ` (exit ${job.exit})`}${covered}${took === "" ? "" : `, ${took}`}.`
				: `Version ${job.version} wasn't checked${job.step === undefined ? "" : ` (${job.step})`}: the box failed twice, or avcs.json has nothing to run.`;
	const output = job.output?.trimEnd() ?? "";
	return [
		head,
		...(output === "" ? [] : [`The end of its output${job.at ? `, ${when(Date.parse(job.at))}` : ""}:`, output]),
	];
}

export async function runCi(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1)
		throw new UsageError("ci takes at most one version: abso ci [<version>] | abso ci --revoke");
	const { api } = open(env);
	const typed = args.positionals[0] ?? str(args, "version");
	try {
		if (bool(args, "revoke")) {
			if (typed !== undefined) throw new UsageError("--revoke takes no version");
			const ci = await api.ciRevoke();
			return {
				text: [
					`Every preview link handed out so far is ended.${ci.latest?.url ? ` The new one: ${ci.latest.url}` : " A new one comes with the next passing build."}`,
				].join("\n"),
				json: { ...ci },
			};
		}
		if (typed !== undefined) {
			if (!/^\d+$/.test(typed)) throw new UsageError(`a version is a number (got ${JSON.stringify(typed)})`);
			const job = await api.ci(Number(typed));
			return { text: jobText(job).join("\n"), json: { ...job } };
		}
		const [ci, status] = await Promise.all([api.ci(), api.status()]);
		const lines = ciText(ci, status.version);
		return {
			text: [
				`shared is at version ${status.version}.`,
				...lines,
				"abso ci <version> shows one version's job and the end of its output.",
			].join("\n"),
			json: { ...ci, version: status.version },
		};
	} catch (e) {
		if (e instanceof ApiError && e.status === 404)
			throw new ApiError("this server has no CI yet (#39); abso serve still builds a preview of a version", 404);
		throw e;
	}
}
