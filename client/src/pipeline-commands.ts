// `abso pipeline check [file]` (abso issue 147, under 138): reads the folder's
// pipeline file and says what's wrong with it, before a publish. Read-only, with
// no server: the reading and checking are src/pipeline/pipeline.ts.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readPipelineFile } from "../../src/pipeline/pipeline.ts";
import { type PipelineEvent, plan } from "../../src/pipeline/plan.ts";
import { type Parsed, str, UsageError } from "./args.ts";
import { type Env, EXIT, type Output } from "./command-env.ts";
import { findRoot } from "./config.ts";

/** The names a pipeline file may have, in the order they're looked for. */
export const PIPELINE_FILES = ["abso.yml", "abso.yaml", "avcs.json"] as const;

export async function runPipeline(args: Parsed, env: Env): Promise<Output> {
	const [sub, file, ...rest] = args.positionals;
	if (sub !== "check" || rest.length > 0) throw new UsageError("abso pipeline check [file]");
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
