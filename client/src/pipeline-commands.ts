// `abso pipeline check [file]`: reads the folder's pipeline file and says what's
// wrong with it, before a publish. Read-only, with no server: the reading and
// checking are src/pipeline/pipeline.ts. `abso pipeline runs` asks the server
// what the project's pipelines did: the runs, one run's jobs, a job's log.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readPipelineFile } from "../../src/pipeline/pipeline.ts";
import { type PipelineEvent, plan } from "../../src/pipeline/plan.ts";
import { type Parsed, str, UsageError } from "./args.ts";
import { type Env, EXIT, type Output, open } from "./command-env.ts";
import { findRoot } from "./config.ts";

/** The names a pipeline file may have, in the order they're looked for. */
export const PIPELINE_FILES = ["abso.yml", "abso.yaml", "abso.json", "avcs.json"] as const;

export async function runPipeline(args: Parsed, env: Env): Promise<Output> {
	const [sub, file, ...rest] = args.positionals;
	if (sub === "runs") return runRuns(file, rest, args, env);
	if (sub !== "check" || rest.length > 0)
		throw new UsageError("abso pipeline check [file] | abso pipeline runs [<run>] [--log <pipeline.job>]");
	const root = findRoot(env.cwd) ?? env.cwd;
	let path: string;
	if (file !== undefined) {
		path = resolve(env.cwd, file);
		if (!existsSync(path)) throw new UsageError(`no file ${file}`);
	} else {
		const found = PIPELINE_FILES.map((n) => join(root, n)).find((p) => existsSync(p));
		if (!found) throw new UsageError(`no pipeline file in ${root}: looked for ${PIPELINE_FILES.join(", ")}`);
		path = found;
	}
	const name = basename(path);
	const checked = readPipelineFile(readFileSync(path, "utf8"), name);
	if (!checked.ok) {
		const problems = checked.problems.map((p) => ({ path: p.at, message: p.message }));
		return {
			text: `${name} has ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join("\n")}\n`,
			json: { file: name, problems },
			exit: EXIT.error,
		};
	}
	const { pipelines } = checked.file;
	const on = str(args, "on");
	if (on !== undefined) {
		const event = eventFrom(on, args);
		const planned = plan(checked.file, event);
		const said =
			event.kind === "schedule"
				? `On the schedule "${event.every}"`
				: `On ${event.kind}${event.kind === "hand" ? ` of ${event.pipeline}` : ""} in ${event.space}`;
		const lines = [
			...planned.start.flatMap((p) => [
				`  ${p.name} starts:`,
				...p.waves.map(
					(w, i) => `    ${i + 1}. ${w.map((j) => `${j}${p.required.includes(j) ? " (required)" : ""}`).join(", ")}`,
				),
			]),
			...planned.skip.map((s) => `  ${s.name} doesn't start: ${s.why}`),
		];
		return {
			text: `${said}, ${planned.start.length === 0 ? "nothing in" : `${planned.start.length === 1 ? "1 pipeline" : `${planned.start.length} pipelines`} from`} ${name} starts; jobs on one line can run side by side.\n${lines.join("\n")}\n`,
			json: { file: name, event, ...planned },
		};
	}
	const lines = pipelines.flatMap((p) => [
		`  ${p.name}, on ${p.on.map((t) => (typeof t === "string" ? t : `every ${t.every}`)).join(", ")}${p.only ? `, only ${p.only.join(", ")}` : ""}:`,
		...p.jobs.map(
			(j) =>
				`    ${j.name}${p.required.includes(j.name) ? " (required)" : ""}: ${j.uses ? `uses ${j.uses}` : j.run}${j.needs.length ? `, after ${j.needs.join(", ")}` : ""}`,
		),
	]);
	return {
		text: `${name} is fine: ${pipelines.length === 1 ? "1 pipeline" : `${pipelines.length} pipelines`}, jobs in the order they run.\n${lines.join("\n")}\n`,
		json: { file: name, pipelines },
	};
}

const KINDS = ["publish", "draft", "green", "land", "hand", "schedule"] as const;

/** --on, with --space, --pipeline (by hand) and --every (a schedule), as an event. */
function eventFrom(on: string, args: Parsed): PipelineEvent {
	if (!(KINDS as readonly string[]).includes(on)) throw new UsageError(`--on is one of ${KINDS.join(", ")}`);
	const space = str(args, "space") ?? "shared";
	if (on === "schedule") {
		const every = str(args, "every");
		if (!every) throw new UsageError('--on schedule takes --every "<when>", as the file writes it');
		return { kind: "schedule", every };
	}
	if (on === "hand") {
		const pipeline = str(args, "pipeline");
		if (!pipeline) throw new UsageError("--on hand takes --pipeline <name>");
		return { kind: "hand", pipeline, space };
	}
	return { kind: on as "publish" | "draft" | "green" | "land", space };
}

/** A run as the server's list gives it. */
export interface RunSummary {
	id: number | null;
	version: number;
	event: string;
	file: string;
	started: number;
	ended: number | null;
	state: string;
	pipelines: { name: string; state: string }[];
}

/** A job of one run, as the server keeps it. */
export interface RunJob {
	pipeline: string;
	job: string;
	needs: string[];
	run?: string;
	uses?: string;
	state: string;
	why?: string;
	exit?: number | null;
	seconds?: number;
	since?: number;
	log?: boolean;
	npm?: { phase: string };
	deploy?: { phase?: string };
}

/** A time in ms as HH:MM UTC, with the date when it isn't today. */
function at(ms: number, now: number): string {
	const t = new Date(ms).toISOString();
	return t.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
		? `${t.slice(11, 16)} UTC`
		: `${t.slice(0, 16).replace("T", " ")} UTC`;
}

/** The runs, newest first, one line each. */
export function runsText(runs: RunSummary[], now = Date.now()): string {
	if (runs.length === 0) return "No pipeline runs yet.\n";
	const lines = runs.map(
		(r) =>
			`  run ${r.id ?? "-"}: version ${r.version} (${r.event}, ${r.file}), ${r.state}, ${at(r.started, now)}${r.ended ? ` to ${at(r.ended, now)}` : ""}: ${r.pipelines.map((p) => `${p.name} ${p.state}`).join(", ")}`,
	);
	return `${lines.join("\n")}\nabso pipeline runs <run> shows its jobs.\n`;
}

/** One run with its jobs: each job's state, why, exit, time and phase, and where its log is. */
export function runText(run: RunSummary & { jobs: RunJob[] }, now = Date.now()): string {
	const lines = run.jobs.map((j) => {
		const parts = [
			j.state,
			j.npm ? `npm ${j.npm.phase}` : "",
			j.deploy?.phase ? `deploy ${j.deploy.phase}` : "",
			j.why ?? "",
			j.exit !== undefined && j.exit !== null ? `exit ${j.exit}` : "",
			j.seconds !== undefined ? `${j.seconds} s` : "",
			j.state === "running" && j.since ? `since ${at(j.since, now)}` : "",
		].filter(Boolean);
		const log = j.log ? `\n      log: abso pipeline runs ${run.id} --log ${j.pipeline}.${j.job}` : "";
		return `  ${j.pipeline}.${j.job} (${j.uses ? `uses ${j.uses}` : j.run}): ${parts.join(", ")}${log}`;
	});
	return `Run ${run.id}: version ${run.version} (${run.event}, ${run.file}), ${run.state}, ${at(run.started, now)}${run.ended ? ` to ${at(run.ended, now)}` : ""}.\n${lines.join("\n")}\n`;
}

async function runRuns(runArg: string | undefined, rest: string[], args: Parsed, env: Env): Promise<Output> {
	const usage = "abso pipeline runs [<run>] [--log <pipeline.job>]";
	if (rest.length > 0) throw new UsageError(usage);
	if (runArg !== undefined && !/^\d+$/.test(runArg))
		throw new UsageError(`a run is a number (got ${runArg}): ${usage}`);
	const log = str(args, "log");
	if (log !== undefined && runArg === undefined) throw new UsageError(`--log needs a run: ${usage}`);
	const { api } = open(env);
	if (runArg === undefined) {
		const { runs } = (await api.pipelineRuns()) as { runs: RunSummary[] };
		return { text: runsText(runs), json: { runs } };
	}
	if (log !== undefined) {
		const got = (await api.pipelineRuns(Number(runArg), log)) as { run: number; job: string; log: string };
		return { text: got.log.endsWith("\n") ? got.log : `${got.log}\n`, json: got };
	}
	const got = (await api.pipelineRuns(Number(runArg))) as RunSummary & { jobs: RunJob[] };
	return { text: runText(got), json: { ...got } };
}
