// The Worker's entry: the router (router.ts) and the Durable Object classes wrangler.jsonc binds.

import type { Env } from "./env.ts";
import { issuesFetch } from "./issues-entry.ts";
import { handle } from "./router.ts";

export { IssueProject } from "./issues-entry.ts";
export { ProjectObject } from "./project-object.ts";

export default {
	fetch: (request, env, ctx) => handle(request, env, ctx, issuesFetch),
} satisfies ExportedHandler<Env>;
