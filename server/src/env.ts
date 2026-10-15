// What the open server's Worker is given: wrangler.jsonc's bindings and the secrets set with `wrangler secret put`.

import type { IssueProject } from "./issues-entry.ts";
import type { ProjectObject } from "./project-object.ts";

export interface Env {
	/** Explicit development opt-in while disk-first server acceptance is in progress. */
	ABSO_DISK_FIRST?: string;
	/** One Durable Object per project, named by the project's name. */
	PROJECT: DurableObjectNamespace<ProjectObject>;
	/** Issues, asks and news: one Durable Object per project, named by the project's name. */
	ISSUES_DO: DurableObjectNamespace<IssueProject>;
	/** Each project's shared, pushed out as a git repo abso-<project>. Unbound under local `wrangler dev`: skipped. */
	ARTIFACTS?: Artifacts;
	/** "off" leaves Artifacts alone even where it is bound: local `wrangler dev --local` binds it but cannot reach it. */
	ABSO_ARTIFACTS?: string;
	CF_VERSION_METADATA?: WorkerVersionMetadata;
	/** The shared token every agent signs in with. AVCS_TOKEN is its old name. With neither set, every call is refused. */
	ABSO_TOKEN?: string;
	AVCS_TOKEN?: string;
	/** For /admin/agent-keys, sent as the x-abso-admin header beside the shared token. */
	ABSO_ADMIN_TOKEN?: string;
	AVCS_ADMIN_TOKEN?: string;
	/** Per-agent keys: "on" with KEY_HMAC_SECRET set. */
	AGENT_KEYS?: string;
	KEY_HMAC_SECRET?: string;
	/** "on" gives a held push a first opinion on each collision from Workers AI (#19); "act" also has the client settle the ones advised a side. Needs the AI binding. */
	AUTOSETTLE?: string;
	/** Which model advises: clef (the default), clef-flash, or a Workers AI text model's id. */
	AUTOSETTLE_MODEL?: string;
	/** The confidence under which a lean to one side is left to an agent: 0.5 unless set. */
	AUTOSETTLE_AT?: string;
	/** Workers AI, for AUTOSETTLE. Unbound unless wrangler.jsonc names it. */
	AI?: { run(model: string, input: unknown): Promise<unknown> };
}

/** A secret by its abso name, or its avcs name from before the rename. Empty counts as unset. */
export function secret(env: Env, name: "TOKEN" | "ADMIN_TOKEN"): string | undefined {
	for (const v of [env[`ABSO_${name}`], env[`AVCS_${name}`]]) if (typeof v === "string" && v !== "") return v;
	return undefined;
}

/** The Artifacts binding, unless it is unbound or ABSO_ARTIFACTS is "off": then nothing is pushed out or taken in. */
export function artifactsOf(env: Env): Artifacts | undefined {
	return env.ABSO_ARTIFACTS === "off" ? undefined : env.ARTIFACTS;
}
