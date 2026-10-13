// Where the router meets issues, asks and news (server/src/issues/, built alongside this file). Until that folder
// lands, this is a stand-in with the same exports, so the Worker builds and its tests run. When it lands, this file
// becomes one line:
//
//   export { IssueProject, issuesFetch } from "./issues/index.ts";
//
// The agreed interface: issuesFetch(request, env, ctx, {project, rest, auth}), where rest is the path after
// /issues/p/<project> and auth is {kind: "token"} or {kind: "key", agent, role}. The router has checked auth before it
// calls. The issues code reaches the project through env.PROJECT and its RPC methods agents(project) and
// news(project, items) on ProjectObject.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { KeyRole } from "./keys.ts";

export type IssuesAuth = { kind: "token" } | { kind: "key"; agent: string; role: KeyRole };

export class IssueProject extends DurableObject<Env> {}

export async function issuesFetch(
	_request: Request,
	_env: Env,
	_ctx: ExecutionContext,
	_where: { project: string; rest: string; auth: IssuesAuth },
): Promise<Response> {
	return Response.json({ error: "issues aren't on this server yet" }, { status: 404 });
}
