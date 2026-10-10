// The pipeline file (abso issue 147, under 138): what a project declares it
// runs, as pipelines of named jobs with dependencies. This reads the file and
// checks its shape; nothing runs it yet. The shape is a draft, not settled, and
// the format is still open, so it reads YAML (abso.yml) and JSON (avcs.json)
// both.
//
// A file holds `defaults` and `pipelines`. Each pipeline says when it runs
// (`on`), optionally which spaces it runs for (`only`), its `jobs`, and which
// jobs make a version green (`required`). A job runs a command (`run`) or a
// built-in step (`uses`), after the jobs it `needs`, and may take another
// job's kept files (`from`) and named `secrets`.
//
// What the check refuses: a cycle in needs; needs, required or from naming a
// job that doesn't exist; secrets in a pipeline a draft can start, since a
// draft runs code nobody has published; and keys it doesn't know. Every
// problem names its place in the file, like pipelines.release.jobs.site.needs.

import { parse as parseYaml, YAMLParseError } from "yaml";

/** What starts a pipeline: a version of shared, an agent's draft, a version going green, a merge-queue landing, by hand, or a schedule. */
export type Trigger = "publish" | "draft" | "green" | "land" | "hand" | { readonly every: string };

export type Size = "small" | "standard" | "large";

/** Where a job runs: an image from the menu, or a Dockerfile in the project (which one is still open). */
export interface Machine {
	readonly image?: string;
	readonly dockerfile?: string;
	readonly size?: Size;
}

export interface Job extends Machine {
	readonly name: string;
	readonly needs: readonly string[];
	readonly run?: string;
	readonly uses?: BuiltIn;
	/** Another job's kept files, as "pipeline.job". */
	readonly from?: string;
	readonly keep: readonly string[];
	readonly cache: readonly string[];
	readonly secrets: readonly string[];
	/** The built-in step's own settings (deploy's worker, staging, live; notify's to), as written. */
	readonly with: Readonly<Record<string, unknown>>;
}

export interface Pipeline {
	readonly name: string;
	readonly on: readonly Trigger[];
	/** The spaces it runs for; absent means every space its triggers reach. */
	readonly only?: readonly string[];
	/** In an order where each job comes after the jobs it needs. */
	readonly jobs: readonly Job[];
	readonly required: readonly string[];
}

export interface PipelineFile {
	readonly defaults: Machine;
	readonly pipelines: readonly Pipeline[];
}

/** One thing wrong, and where: a dotted path into the file, or "file" for the file as a whole. */
export interface Problem {
	readonly at: string;
	readonly message: string;
}

export type Checked =
	| { readonly ok: true; readonly file: PipelineFile }
	| { readonly ok: false; readonly problems: readonly Problem[] };

export const BUILT_INS = ["deploy", "preview", "notify", "npm-publish"] as const;
export type BuiltIn = (typeof BUILT_INS)[number];

/** Each built-in step's own settings, beside the keys every job has. */
const BUILT_IN_SETTINGS: Readonly<Record<BuiltIn, readonly string[]>> = {
	deploy: ["worker", "staging", "live"],
	preview: [],
	notify: ["to"],
	// The npm packages it may publish, from the .tgz files its from: job kept.
	"npm-publish": ["packages"],
};

/** An npm package name: lower case, URL-safe, optionally under a @scope/. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const TRIGGERS = ["publish", "draft", "green", "land", "hand"] as const;
const SIZES: readonly Size[] = ["small", "standard", "large"];
const MACHINE_KEYS = ["image", "dockerfile", "size"] as const;
const JOB_KEYS = ["needs", "run", "uses", "from", "keep", "cache", "secrets", ...MACHINE_KEYS] as const;
const PIPELINE_KEYS = ["on", "only", "jobs", "required"] as const;
/** avcs.json's keys for today's CI (worker/src/ci.ts) and the merge queue: read elsewhere, left alone here. */
const AVCS_JSON_KEYS = ["setup", "check", "build", "out", "queue", "whole"] as const;

const NAME = /^[a-z][a-z0-9_-]*$/;
const SECRET = /^[A-Z][A-Z0-9_]*$/;

/**
 * Reads a pipeline file's text. `fileName` picks the format: .json is JSON
 * (avcs.json keeps its other keys, which this leaves to their readers), .yml
 * and .yaml are YAML.
 */
export function readPipelineFile(text: string, fileName: string): Checked {
	const json = /\.json$/i.test(fileName);
	if (!json && !/\.ya?ml$/i.test(fileName))
		return fail([{ at: "file", message: `${fileName} isn't .json, .yml or .yaml, so its format can't be told` }]);
	let doc: unknown;
	try {
		// YAML 1.2, the library's default: `on` is a key, not true.
		doc = json ? JSON.parse(text) : parseYaml(text, { uniqueKeys: true, prettyErrors: true });
	} catch (e) {
		const where = e instanceof YAMLParseError && e.linePos ? ` at line ${e.linePos[0].line}` : "";
		const first = String(e instanceof Error ? e.message : e).split("\n")[0];
		return fail([{ at: "file", message: `${fileName} isn't valid ${json ? "JSON" : "YAML"}${where}: ${first}` }]);
	}
	return checkPipelines(doc, { avcsJson: /(^|[\\/])(abso|avcs)\.json$/i.test(fileName) });
}

/** Checks a parsed file. With `avcsJson`, today's CI keys beside the pipelines are allowed. */
export function checkPipelines(doc: unknown, { avcsJson = false } = {}): Checked {
	const problems: Problem[] = [];
	const say = (at: string, message: string) => problems.push({ at, message });
	if (!isRecord(doc)) return fail([{ at: "file", message: "the file must be a map with pipelines in it" }]);
	unknownKeys(doc, ["defaults", "pipelines", ...(avcsJson ? AVCS_JSON_KEYS : [])], "", say);
	if (avcsJson && doc.pipelines === undefined) {
		const ci = shorthand(doc, say);
		if (ci) doc = { ...doc, pipelines: { ci } };
		if (!isRecord(doc)) return fail(problems);
	}

	const defaults = machine(doc.defaults, "defaults", say, true);
	const pipelines: Pipeline[] = [];
	if (doc.pipelines === undefined) say("pipelines", "is missing");
	else if (!isRecord(doc.pipelines)) say("pipelines", "must be a map of pipeline names to pipelines");
	else {
		if (Object.keys(doc.pipelines).length === 0) say("pipelines", "has no pipelines");
		for (const [name, p] of Object.entries(doc.pipelines)) {
			const read = pipeline(name, p, `pipelines.${name}`, say);
			if (read) pipelines.push(read);
		}
	}
	// from points across pipelines, so it's checked once every pipeline is read.
	for (const p of pipelines)
		for (const j of p.jobs) {
			if (j.from === undefined) continue;
			const at = `pipelines.${p.name}.jobs.${j.name}.from`;
			const [pn, jn, ...rest] = j.from.split(".");
			const source = pipelines.find((q) => q.name === pn);
			const job = source?.jobs.find((k) => k.name === jn);
			if (!pn || !jn || rest.length) say(at, `must be <pipeline>.<job>, not ${q(j.from)}`);
			else if (!source) say(at, `names pipeline ${q(pn)}, which doesn't exist`);
			else if (!job) say(at, `names job ${q(jn)}, which pipeline ${q(pn)} doesn't have`);
			else if (job.keep.length === 0) say(at, `names ${q(j.from)}, which keeps no files (give it keep)`);
		}
	return problems.length ? fail(problems) : { ok: true, file: { defaults, pipelines } };
}

type Say = (at: string, message: string) => void;

/**
 * avcs.json's setup, check and build, with no pipelines beside them, as the one
 * pipeline they are shorthand for (abso issue 162): ci, the job today's CI runs
 * (worker/src/ci.ts). Setup, then build keeping its out folder, then check, in
 * today's order; every step required, as a failed step fails today's job. On
 * publish only: whether CI runs on drafts by default is still open, so the
 * shorthand doesn't add it.
 */
function shorthand(doc: Record<string, unknown>, say: Say): Record<string, unknown> | undefined {
	const step = (k: "setup" | "check" | "build") => {
		const v = doc[k];
		if (v === undefined) return undefined;
		if (typeof v !== "string") say(k, "must be a command");
		// An empty command counts as none, as today's CI reads it.
		return typeof v === "string" && v.trim() ? v : undefined;
	};
	const setup = step("setup");
	const build = step("build");
	const check = step("check");
	const out = doc.out ?? "dist";
	if (typeof out !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(out) || out.split("/").includes(".."))
		say("out", `must be a folder under the project, like dist, not ${q(out)}`);
	if (!setup && !build && !check) return undefined;
	const jobs: Record<string, unknown> = {};
	let last: string | undefined;
	for (const [name, run] of [
		["setup", setup],
		["build", build],
		["check", check],
	] as const) {
		if (!run) continue;
		jobs[name] = { run, ...(last ? { needs: [last] } : {}), ...(name === "build" ? { keep: [`${out}/**`] } : {}) };
		last = name;
	}
	return { on: ["publish"], jobs, required: Object.keys(jobs) };
}

function pipeline(name: string, p: unknown, at: string, say: Say): Pipeline | undefined {
	if (!NAME.test(name))
		say(at, `${q(name)} isn't a usable name: lower-case letters, digits, - and _, starting with a letter`);
	if (!isRecord(p)) {
		say(at, "must be a map with on and jobs");
		return undefined;
	}
	unknownKeys(p, PIPELINE_KEYS, at, say);
	const on = triggers(p.on, `${at}.on`, say);
	const only = p.only === undefined ? undefined : strings(p.only, `${at}.only`, say, "a space name or a list of them");
	if (only?.length === 0) say(`${at}.only`, "is empty, so the pipeline would never run");

	const jobs: Job[] = [];
	if (p.jobs === undefined) say(`${at}.jobs`, "is missing");
	else if (!isRecord(p.jobs)) say(`${at}.jobs`, "must be a map of job names to jobs");
	else {
		if (Object.keys(p.jobs).length === 0) say(`${at}.jobs`, "has no jobs");
		for (const [jn, j] of Object.entries(p.jobs)) {
			const read = job(jn, j, `${at}.jobs.${jn}`, say);
			if (read) jobs.push(read);
		}
	}
	const names = new Set(jobs.map((j) => j.name));
	for (const j of jobs)
		j.needs.forEach((n, i) => {
			if (!names.has(n))
				say(
					`${at}.jobs.${j.name}.needs[${i}]`,
					n.includes(".")
						? `names ${q(n)}: needs reaches only jobs in this pipeline; take another pipeline's files with from`
						: `names job ${q(n)}, which this pipeline doesn't have`,
				);
			if (n === j.name) say(`${at}.jobs.${j.name}.needs[${i}]`, "names the job itself");
		});
	const required =
		p.required === undefined ? [] : (strings(p.required, `${at}.required`, say, "a list of job names") ?? []);
	required.forEach((n, i) => {
		if (!names.has(n)) say(`${at}.required[${i}]`, `names job ${q(n)}, which this pipeline doesn't have`);
	});

	// Secrets go only where no draft can reach them: a draft runs code nobody
	// has published, which could send a secret anywhere.
	const holding = jobs.filter((j) => j.secrets.length > 0);
	if (holding.length) {
		const who = holding.map((j) => j.name).join(", ");
		if (on?.includes("draft"))
			say(
				`${at}.on`,
				`includes draft, but ${who} hold${holding.length === 1 ? "s" : ""} secrets; a draft runs unpublished code`,
			);
		if (!only || only.some((s) => s !== "shared"))
			say(
				`${at}.only`,
				`must be shared, because ${who} hold${holding.length === 1 ? "s" : ""} secrets and a named draft's version is no one's published work`,
			);
	}

	const ordered = order(jobs, `${at}.jobs`, say);
	if (!on || !ordered) return undefined;
	return { name, on, ...(only ? { only } : {}), jobs: ordered, required };
}

function job(name: string, j: unknown, at: string, say: Say): Job | undefined {
	if (!NAME.test(name))
		say(at, `${q(name)} isn't a usable name: lower-case letters, digits, - and _, starting with a letter`);
	if (!isRecord(j)) {
		say(at, "must be a map with run or uses");
		return undefined;
	}
	let uses: BuiltIn | undefined;
	if (j.uses !== undefined) {
		if (typeof j.uses === "string" && (BUILT_INS as readonly string[]).includes(j.uses)) uses = j.uses as BuiltIn;
		else say(`${at}.uses`, `must be one of ${BUILT_INS.join(", ")}, not ${q(j.uses)}`);
	}
	const settings = uses ? BUILT_IN_SETTINGS[uses] : [];
	unknownKeys(j, [...JOB_KEYS, ...settings], at, say, j.uses !== undefined && !uses);
	const run = j.run;
	if (run !== undefined && (typeof run !== "string" || !run.trim())) say(`${at}.run`, "must be a command");
	if (run === undefined && j.uses === undefined) say(at, "needs run (a command) or uses (a built-in step)");
	if (run !== undefined && j.uses !== undefined) say(at, "has both run and uses; a job does one");
	if (j.from !== undefined && typeof j.from !== "string") say(`${at}.from`, "must be <pipeline>.<job>");
	const secrets = list(j.secrets, `${at}.secrets`, say, "a list of secret names");
	secrets.forEach((s, i) => {
		if (!SECRET.test(s)) say(`${at}.secrets[${i}]`, `${q(s)} isn't a secret name: upper-case letters, digits and _`);
	});
	const withs: Record<string, unknown> = {};
	for (const k of settings) if (j[k] !== undefined) withs[k] = j[k];
	if (uses === "deploy" && typeof j.worker !== "string")
		say(`${at}.worker`, "names the Worker deploy ships, and is missing");
	if (uses === "npm-publish") {
		if (j.from === undefined)
			say(`${at}.from`, "names the job whose kept .tgz files npm-publish publishes, and is missing");
		const packages = j.packages;
		if (!Array.isArray(packages) || packages.length === 0)
			say(`${at}.packages`, "lists the npm packages npm-publish may publish, and is missing");
		else
			packages.forEach((p, i) => {
				if (typeof p !== "string" || p.length > 214 || !NPM_NAME.test(p))
					say(`${at}.packages[${i}]`, `${q(p)} isn't an npm package name`);
			});
	}
	return {
		name,
		needs: list(j.needs, `${at}.needs`, say, "a list of job names"),
		...(typeof run === "string" ? { run } : {}),
		...(uses ? { uses } : {}),
		...(typeof j.from === "string" ? { from: j.from } : {}),
		keep: list(j.keep, `${at}.keep`, say, "a list of file patterns"),
		cache: list(j.cache, `${at}.cache`, say, "a list of files"),
		secrets,
		with: withs,
		...machine(j, at, say, false),
	};
}

/** image, dockerfile and size, from defaults (alone) or a job (among its other keys). */
function machine(m: unknown, at: string, say: Say, alone: boolean): Machine {
	if (m === undefined) return {};
	if (!isRecord(m)) {
		say(at, "must be a map");
		return {};
	}
	if (alone) unknownKeys(m, MACHINE_KEYS, at, say);
	const out: { image?: string; dockerfile?: string; size?: Size } = {};
	if (m.image !== undefined) {
		if (typeof m.image === "string" && m.image) out.image = m.image;
		else say(`${at}.image`, "must be an image name");
	}
	if (m.dockerfile !== undefined) {
		if (typeof m.dockerfile === "string" && m.dockerfile) out.dockerfile = m.dockerfile;
		else say(`${at}.dockerfile`, "must be a path in the project");
	}
	if (out.image && out.dockerfile) say(at, "has both image and dockerfile; give one");
	if (m.size !== undefined) {
		if (SIZES.includes(m.size as Size)) out.size = m.size as Size;
		else say(`${at}.size`, `must be one of ${SIZES.join(", ")}, not ${q(m.size)}`);
	}
	return out;
}

function triggers(on: unknown, at: string, say: Say): Trigger[] | undefined {
	if (on === undefined) {
		say(at, "is missing: say when the pipeline runs");
		return undefined;
	}
	const all = Array.isArray(on) ? on : [on];
	if (all.length === 0) {
		say(at, "is empty, so the pipeline would never run");
		return undefined;
	}
	const out: Trigger[] = [];
	all.forEach((t, i) => {
		const here = Array.isArray(on) ? `${at}[${i}]` : at;
		if (typeof t === "string" && (TRIGGERS as readonly string[]).includes(t)) out.push(t as Trigger);
		else if (isRecord(t) && Object.keys(t).length === 1 && typeof t.every === "string" && t.every.trim())
			out.push({ every: t.every });
		else say(here, `must be one of ${TRIGGERS.join(", ")}, or { every: "<when>" }, not ${q(t)}`);
	});
	return out.length === all.length ? out : undefined;
}

/** The jobs in an order where each comes after the jobs it needs; a cycle is a problem, named by its jobs. */
function order(jobs: readonly Job[], at: string, say: Say): Job[] | undefined {
	const byName = new Map(jobs.map((j) => [j.name, j]));
	const done = new Set<string>();
	const out: Job[] = [];
	const cycles = new Set<string>();
	const visit = (j: Job, path: string[]) => {
		if (done.has(j.name)) return;
		const seen = path.indexOf(j.name);
		if (seen >= 0) {
			const loop = [...path.slice(seen), j.name];
			// The same cycle found from another job is one problem.
			const key = [...loop.slice(0, -1)].sort().join(",");
			if (!cycles.has(key)) {
				cycles.add(key);
				say(at, `needs go round in a cycle: ${loop.join(" → ")}`);
			}
			return;
		}
		for (const n of j.needs) {
			const k = byName.get(n);
			if (k && k !== j) visit(k, [...path, j.name]);
		}
		if (!done.has(j.name)) {
			done.add(j.name);
			out.push(j);
		}
	};
	for (const j of jobs) visit(j, []);
	return cycles.size ? undefined : out;
}

function unknownKeys(m: Record<string, unknown>, known: readonly string[], at: string, say: Say, quiet = false) {
	if (quiet) return;
	for (const k of Object.keys(m))
		if (!known.includes(k)) say(at ? `${at}.${k}` : k, `isn't a key here (known: ${known.join(", ")})`);
}

/** A list of strings, or one string as a list of one; a problem when it's neither. */
function strings(v: unknown, at: string, say: Say, what: string): string[] | undefined {
	const all = typeof v === "string" ? [v] : v;
	if (!Array.isArray(all) || all.some((s) => typeof s !== "string" || !s)) {
		say(at, `must be ${what}`);
		return undefined;
	}
	return all as string[];
}

const list = (v: unknown, at: string, say: Say, what: string): string[] =>
	v === undefined ? [] : (strings(v, at, say, what) ?? []);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);
const fail = (problems: Problem[]): Checked => ({ ok: false, problems });
