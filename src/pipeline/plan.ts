// Which pipelines an event starts, and their jobs in waves (abso issue 176,
// under 138). A pure function of a checked pipeline file (pipeline.ts) and the
// event: nothing runs here. A wave is every job whose needs are all in earlier
// waves, so the jobs of one wave can run side by side. `abso pipeline check
// --on <event>` shows it, and a runner reads the same plan.

import type { Job, Pipeline, PipelineFile } from "./pipeline.ts";

/** What happened, and in which space (shared, or a named draft). */
export type PipelineEvent =
	| { readonly kind: "publish" | "draft" | "green" | "land"; readonly space: string }
	/** Someone starts one pipeline by name. */
	| { readonly kind: "hand"; readonly pipeline: string; readonly space: string }
	/** A schedule's time came: `every` as the file wrote it. Schedules run on shared. */
	| { readonly kind: "schedule"; readonly every: string };

export interface PlannedPipeline {
	readonly name: string;
	/** Job names, wave by wave. */
	readonly waves: readonly (readonly string[])[];
	readonly required: readonly string[];
}

export interface Plan {
	readonly start: readonly PlannedPipeline[];
	/** The pipelines that don't start, each with why. */
	readonly skip: readonly { readonly name: string; readonly why: string }[];
}

export function plan(file: PipelineFile, event: PipelineEvent): Plan {
	const start: PlannedPipeline[] = [];
	const skip: { name: string; why: string }[] = [];
	const space = event.kind === "schedule" ? "shared" : event.space;
	for (const p of file.pipelines) {
		const why = notStarting(p, event, space);
		if (why) skip.push({ name: p.name, why });
		else start.push({ name: p.name, waves: waves(p.jobs), required: p.required });
	}
	return { start, skip };
}

/** Why `p` doesn't start on `event`, or undefined when it does. */
function notStarting(p: Pipeline, event: PipelineEvent, space: string): string | undefined {
	if (event.kind === "hand" && event.pipeline !== p.name) return "another pipeline was started by hand";
	const on =
		event.kind === "schedule"
			? p.on.some((t) => typeof t !== "string" && t.every === event.every)
			: p.on.includes(event.kind);
	if (!on) return event.kind === "schedule" ? `has no schedule "${event.every}"` : `doesn't run on ${event.kind}`;
	if (p.only && !p.only.includes(space)) return `runs only for ${p.only.join(", ")}, not ${space}`;
	// The file check refuses this already; the plan holds the line too.
	if (event.kind === "draft" && p.jobs.some((j) => j.secrets.length > 0))
		return "holds secrets, and a draft runs unpublished code";
	return undefined;
}

/** The jobs in waves: each wave holds every job whose needs all came in earlier waves. */
export function waves(jobs: readonly Job[]): string[][] {
	const done = new Set<string>();
	const out: string[][] = [];
	let left = [...jobs];
	while (left.length > 0) {
		const wave = left.filter((j) => j.needs.every((n) => done.has(n)));
		// A checked file has no cycles; stop rather than loop if one ever got here.
		if (wave.length === 0) throw new Error(`jobs ${left.map((j) => j.name).join(", ")} wait on each other`);
		for (const j of wave) done.add(j.name);
		out.push(wave.map((j) => j.name));
		left = left.filter((j) => !done.has(j.name));
	}
	return out;
}
