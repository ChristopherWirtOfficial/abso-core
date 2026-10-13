// The open server's router (index.ts is the Worker's entry). abso's open server: one Worker that anyone deploys to their own Cloudflare account (`cd server && npx wrangler
// deploy`). Every project is a Durable Object named by the project's name; its shared is pushed out to an Artifacts
// repo abso-<project>. The routes are the platform's core routes, so the stock client works against it:
//
//   GET  /version                          the deployed version's tag; no token needed
//   /p/<project>/<read or init>            init, status, log, show, file, blame, feed and the other reads (http.ts)
//   /p/<project>/a/<agent>/<op>            an agent's calls: record, publish, sync, draft, land, announce, ...
//   GET  /p/<project>/head                 shared's newest version, read from storage without loading the project
//   PUT|GET /p/<project>/blobs/<sha256>    a binary file's bytes; a PUT whose bytes don't hash to the name is refused
//   GET  /p/<project>/out                  the push out to Artifacts: repo, last version pushed, plain-git intake
//   POST /p/<project>/git-remote           the repo's remote and a write token good for an hour, for plain git
//   POST /p/<project>/git-sync             takes in commits pushed with plain git now (the alarm also does)
//   GET  /p/<project>/export?from=&limit=  the log as JSON lines, for backups
//   /issues/p/<project>/...                issues, asks and news (issues-entry.ts)
//   GET|POST /admin/agent-keys?project=    per-agent keys: list, or issue (?agent=&role=&expires=); POST .../revoke?id=
//
// Every route but /version needs Authorization: Bearer <ABSO_TOKEN>, or an agent's key when AGENT_KEYS is on. With no
// ABSO_TOKEN set, the server refuses every call.

import { type Answer, validName } from "../../worker/project/http.ts";
import { artifactsOf, type Env, secret } from "./env.ts";
import type { IssuesAuth, issuesFetch } from "./issues-entry.ts";
import { isAgentKey, type KeyRole, keyAllows, keysEnabled, timingSame } from "./keys.ts";
import type { KeyForCall } from "./project-object.ts";
import { repoName, writeAccess } from "./push.ts";

const AGENT_OPS =
	"edit|record|publish|sync|draft|draft-sync|land|pluck|amend|diff|restore|drop|label|announce|news|note|note-close|move|starting|reader|files|status|unqueue";
const TOP_ROUTES =
	"init|status|head|out|export|blobs/[^/]+|git-sync|git-remote|blame|why|tree|path|follow|collisions|draft-state|where|feed|drafts|diff|ribbon|position|changes|notes|change/[0-9]{1,12}|refusals|labels|files|announce|log|show|file|compare|visibility|ci|queue";

/** A project's routes: the project, the top-level route, and an agent's name and op under /a/. */
export const PROJECT_ROUTE = new RegExp(`^/p/([^/]+)/(${TOP_ROUTES}|a/([^/]+)/(${AGENT_OPS}))$`);
/** Issues, asks and news: the project and the rest of the path, handed to the issues code. */
export const ISSUES_ROUTE = /^\/issues\/p\/([^/]+)(\/.*)?$/;

/** Routes answered here or by a direct object method, not through the project call. */
const DIRECT = new Set(["head", "out", "export", "git-remote", "git-sync", "ci", "queue", "visibility"]);
/** Reads whose query string is the call's body. */
const QUERY_READS = new Set([
	"status",
	"blame",
	"why",
	"tree",
	"path",
	"follow",
	"collisions",
	"draft-state",
	"refusals",
	"labels",
	"log",
	"show",
	"file",
	"files",
	"compare",
	"where",
	"feed",
	"drafts",
	"diff",
	"ribbon",
	"position",
	"changes",
	"notes",
]);
const SHA = /^[0-9a-f]{64}$/;

const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Whether two secrets match, in constant time whatever their lengths: their SHA-256 digests are compared. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
	const digest = async (s: string) =>
		[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
			.map((n) => n.toString(16).padStart(2, "0"))
			.join("");
	return timingSame(await digest(a), await digest(b));
}

export type Caller = { kind: "token" } | { kind: "key"; presented: string };

/**
 * Who is calling: the shared token, or an agent key to be checked by its project. A Response is a refusal. With no
 * shared token set, everything is refused.
 */
export async function authorize(request: Request, env: Env): Promise<Caller | Response> {
	const shared = secret(env, "TOKEN");
	if (!shared)
		return json(503, {
			error:
				"this server has no ABSO_TOKEN set, so it refuses every call; set one with npx wrangler secret put ABSO_TOKEN",
		});
	const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
	if (presented && isAgentKey(presented) && keysEnabled(env)) return { kind: "key", presented };
	if (presented && (await sameSecret(presented, shared))) return { kind: "token" };
	return json(401, { error: "missing or wrong token" });
}

/** The x-abso-admin header against ABSO_ADMIN_TOKEN, in constant time. */
async function isAdmin(request: Request, env: Env): Promise<boolean> {
	const token = secret(env, "ADMIN_TOKEN");
	const sent = request.headers.get("x-abso-admin") ?? request.headers.get("x-avcs-admin");
	return !!token && !!sent && (await sameSecret(sent, token));
}

const addressOf = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";
const projectObject = (env: Env, project: string) => env.PROJECT.get(env.PROJECT.idFromName(project));

/** Per-agent keys for one project: list (GET), issue (POST ?agent=&role=&expires=), revoke (POST .../revoke?id=). */
async function agentKeys(request: Request, env: Env, url: URL, caller: Caller): Promise<Response> {
	if (!keysEnabled(env))
		return json(404, { error: "agent keys are off here: AGENT_KEYS=on and KEY_HMAC_SECRET turn them on" });
	if (caller.kind !== "token") return json(401, { error: "missing or wrong token" });
	if (!(await isAdmin(request, env))) return json(403, { error: "agent keys need x-abso-admin: <the admin token>" });
	const project = url.searchParams.get("project") ?? "";
	if (!validName(project)) return json(400, { error: "agent keys need ?project=<name>" });
	const obj = projectObject(env, project);
	if (url.pathname === "/admin/agent-keys/revoke") {
		if (request.method !== "POST") return json(405, { error: "revoking a key is a POST" });
		return json(200, await obj.revokeAgentKey(url.searchParams.get("id") ?? "", addressOf(request)));
	}
	if (request.method === "GET")
		return json(200, { keys: await obj.listAgentKeys(url.searchParams.get("agent") ?? undefined) });
	if (request.method !== "POST") return json(405, { error: "agent keys take GET or POST" });
	const agent = url.searchParams.get("agent") ?? "";
	if (!validName(agent)) return json(400, { error: "issuing a key needs ?agent=<name>" });
	const role = url.searchParams.get("role") ?? "writer";
	if (role !== "owner" && role !== "writer" && role !== "reader")
		return json(400, { error: "role is owner, writer or reader" });
	const issued = await obj.issueAgentKey(agent, addressOf(request), url.searchParams.get("expires"), role);
	return "error" in issued ? json(400, issued) : json(200, issued);
}

/** The engine's ci and queue reads, for a server with neither: empty, so status and log say nothing about them. */
const NO_CI = { latest: null, checked: null, running: null, red: null, behind: null };
const NO_QUEUE = { items: [], paused: null };

async function projectRoute(
	request: Request,
	env: Env,
	url: URL,
	caller: Caller,
	match: RegExpExecArray,
): Promise<Response> {
	const [, project, top, agent, op] = match as unknown as [
		string,
		string,
		string,
		string | undefined,
		string | undefined,
	];
	if (!validName(project)) return json(400, { error: "project names use letters, digits, '.', '_' and '-'" });
	const obj = projectObject(env, project);
	const route = agent === undefined ? top : op;
	const write = request.method !== "GET" && request.method !== "HEAD";
	const blob = top.startsWith("blobs/");
	let keyForCall: KeyForCall | undefined;
	let how: string | undefined;
	if (caller.kind === "key") {
		if (DIRECT.has(top) || blob) {
			const decided = await obj.checkAgentKey(caller.presented, agent, addressOf(request));
			if (!decided.ok) return json(decided.status, { error: decided.error });
			const allowed = keyAllows(decided.role, { write, agent, route, method: request.method });
			if (!allowed.ok) return json(allowed.status, { error: allowed.error });
			how = decided.as;
		} else keyForCall = { presented: caller.presented, address: addressOf(request), write, route };
	}

	if (top === "head") {
		if (request.method !== "GET") return json(405, { error: "head is a GET" });
		const head = await obj.head();
		return head ? json(200, head) : json(404, { error: "no such project; run init first" });
	}
	if (top === "out") return json(200, await obj.out());
	if (top === "ci") return json(200, NO_CI);
	if (top === "queue") return json(200, NO_QUEUE);
	if (top === "visibility") {
		if (request.method !== "GET")
			return json(400, { error: "every project on this server is private: it answers only its token and keys" });
		return json(200, { project, visibility: "private" });
	}
	if (blob) {
		const sha = top.slice("blobs/".length);
		if (!SHA.test(sha)) return json(400, { error: "a blob's name is its SHA-256 in lowercase hex" });
		if (request.method === "PUT") {
			if (!request.body) return json(400, { error: "PUT the blob's bytes as the body" });
			const a = (await obj.putBlob(sha, request.body)) as unknown as Answer;
			return json(a.status, a.body);
		}
		if (request.method !== "GET") return json(405, { error: "blobs take GET or PUT" });
		const bytes = await obj.getBlob(sha);
		if (!bytes) return json(404, { error: `no blob ${sha} in this project` });
		return new Response(bytes, {
			headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" },
		});
	}
	if (top === "export") {
		const from = Number(url.searchParams.get("from") ?? "0");
		const limit = Number(url.searchParams.get("limit") ?? "500");
		if (!Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5000)
			return json(400, { error: "export takes ?from=<seq>&limit=<1-5000>" });
		const page = await obj.exportLog(from, limit);
		if (page === null) return json(404, { error: "no such project; run init first" });
		return new Response(page.lines, {
			headers: {
				"content-type": "application/x-ndjson",
				"x-abso-next": page.next === null ? "" : String(page.next),
				"cache-control": "no-store",
			},
		});
	}
	if (top === "git-remote") {
		// For a person who works with plain git: clone, commit, push; the project takes the commits in.
		if (request.method !== "POST") return json(405, { error: "git-remote is a POST" });
		const artifacts = artifactsOf(env);
		if (!artifacts) return json(501, { error: "this server has no Artifacts binding, so no git remote" });
		if ((await obj.head()) === null) return json(404, { error: "no such project; run init first" });
		const { remote, secret: token } = await writeAccess(artifacts, repoName(project), 3600);
		// The token goes in a header for each git call, never in the remote URL or a credential store.
		const header = `Authorization: Basic ${btoa(`x:${token}`)}`;
		const git = `git -c credential.helper= -c http.extraHeader="${header}"`;
		return json(200, {
			remote,
			token,
			expiresIn: 3600,
			header,
			clone: `${git} clone ${remote}`,
			fetch: `${git} fetch`,
			push: `${git} push`,
		});
	}
	if (top === "git-sync") {
		if (request.method !== "POST") return json(405, { error: "git-sync is a POST" });
		try {
			return json(200, { taken: await obj.gitSync() });
		} catch (e) {
			return json(502, { error: `could not read the project's repo: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	let body: unknown;
	if (request.method === "POST") {
		const text = await request.text();
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				return json(400, { error: "the body must be JSON" });
			}
		}
	} else if (request.method === "GET" && (QUERY_READS.has(route ?? "") || top.startsWith("change/"))) {
		body = Object.fromEntries(url.searchParams);
	} else return json(405, { error: `${route} is a POST` });
	// Which client sent a recording goes in the log with it.
	if ((op === "edit" || op === "record") && body && typeof body === "object") {
		const client = request.headers.get("x-abso-client") ?? request.headers.get("x-avcs-client") ?? "";
		const { client: _, ...rest } = body as Record<string, unknown>;
		body = { ...rest, ...(/^[\w.+-]{1,20}\/[\w.+-]{1,40}$/.test(client) ? { client } : {}) };
	}
	try {
		const a = (await obj.call(project, (op ?? top)!, agent, body, false, how, keyForCall)) as unknown as Answer;
		return json(a.status, a.body);
	} catch (e) {
		const error = `the project object failed: ${e instanceof Error ? e.message : String(e)}`;
		console.error(`${project} ${op ?? top}: ${error}`);
		return json(500, { error });
	}
}

/** One request. The issues code comes in as an argument, so this file loads without the Workers runtime (tests). */
export async function handle(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	issues: typeof issuesFetch,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/version") return json(200, { commit: env.CF_VERSION_METADATA?.tag || null });
	const caller = await authorize(request, env);
	if (caller instanceof Response) return caller;
	if (url.pathname === "/")
		return new Response("abso: agent-first version control. The API lives under /p/<project>.\n");
	if (url.pathname === "/admin/agent-keys" || url.pathname === "/admin/agent-keys/revoke")
		return agentKeys(request, env, url, caller);
	const onIssues = ISSUES_ROUTE.exec(url.pathname);
	if (onIssues) {
		const project = decodeURIComponent(onIssues[1]!);
		if (!validName(project)) return json(400, { error: "project names use letters, digits, '.', '_' and '-'" });
		let auth: IssuesAuth = { kind: "token" };
		if (caller.kind === "key") {
			const decided = await projectObject(env, project).checkAgentKey(caller.presented, undefined, addressOf(request));
			if (!decided.ok) return json(decided.status, { error: decided.error });
			auth = { kind: "key", agent: decided.agent, role: decided.role as KeyRole };
		}
		return issues(request, env, ctx, { project, rest: onIssues[2] ?? "", auth });
	}
	const m = PROJECT_ROUTE.exec(url.pathname);
	if (!m) return json(404, { error: "no such route" });
	return projectRoute(request, env, url, caller, m);
}
