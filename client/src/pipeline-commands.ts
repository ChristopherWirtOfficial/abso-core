// `abso pipeline check [file]` (abso issue 147, under 138): reads the folder's
// pipeline file and says what's wrong with it, before a publish. Read-only, with
// no server: the reading and checking are src/pipeline/pipeline.ts.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readPipelineFile } from "../../src/pipeline/pipeline.ts";
import { type Parsed, UsageError } from "./args.ts";
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
