// How the open server's Worker reaches a project's issues, and what the IssueProject object does with a
// request, apart from Cloudflare's own types so both run under node --test.
//
//   issuesFetch    the Worker's entry for /issues/p/:project/...: the router has checked the token or key;
//                  this checks that a key acts only as its own agent (and a reader's only reads), hands the
//                  request to the project's IssueProject, and delivers a write's news to the project.
//   IssuesObject   one project's issues: migrations, the store, and its routes (routes.ts). An ask's `of` is
//                  checked against the project's agents.
//
// The project object (env.PROJECT, named by the project) is asked two things, both optional: agents(project)
// for the ask check, and news(project, items) to deliver a write's news as announcements. Without them the
// check is skipped and the news is dropped with a log line.

import type { News } from "../../../client/src/issues-wire.ts";
import { BODY_MAX, issuesRoute, json, readCapped } from "./routes.ts";
import { seatRefusal } from "./seats.ts";
import { IssuesError, IssuesStore, SCHEMA, type Sql } from "./store.ts";

/** A write's news for the project to deliver: the issue's claimers and those in `to` hear it, never `from`. */
export interface IssueNews extends News {
	/** The agent whose write it was. */
	from: string;
}

/** What issues asks of the project's own object. Each method is optional: an older project object may lack it. */
export interface ProjectHooks {
	/** The agents in the project, which an ask may go to. */
	agents?(project: string): Promise<string[]>;
	/** Deliver each item as an announcement from `from` to the issue's claimers and `to`. */
	news?(project: string, items: IssueNews[]): Promise<unknown>;
}

/** A Durable Object namespace as far as issues uses one; Cloudflare's DurableObjectNamespace fits it. */
export interface NamespaceLike {
	idFromName(name: string): unknown;
	get(id: never): object;
}

/** The bindings issues reads. */
export interface IssuesEnv {
	/** One IssueProject per project, named by the project's name. */
	ISSUES_DO: NamespaceLike;
	/** The project objects, named by the project's name; their stubs answer ProjectHooks. */
	PROJECT?: NamespaceLike;
}

/** How the router let the request in: the shared token acts as any agent; a key only as its own agent. */
export type IssuesAuth = { kind: "token" } | { kind: "key"; agent: string; role: string };

/** What issuesFetch needs from the Worker's context. */
export interface WaitUntil {
	waitUntil(promise: Promise<unknown>): void;
}

const PROJECT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function stubOf<T>(ns: NamespaceLike, name: string): T {
	const n = ns as unknown as { idFromName(name: string): unknown; get(id: unknown): T };
	return n.get(n.idFromName(name));
}

/** The project object's stub, as far as issues calls it; undefined when PROJECT isn't bound. */
function hooksOf(env: IssuesEnv, project: string): ProjectHooks | undefined {
	return env.PROJECT === undefined ? undefined : stubOf<ProjectHooks>(env.PROJECT, project);
}

/**
 * Whether an RPC call failed because the receiver has no such method. On an RPC stub every property reads as a
 * function, so only the call can tell: it fails with this error.
 */
export function missingMethod(e: unknown): boolean {
	const message = e instanceof Error ? e.message : String(e);
	return /does not implement (the )?method|is not a function/i.test(message);
}

/**
 * /issues/p/:project<rest> after the router's sign-in check. `rest` is the path after the project, like
 * /a/lead/ask or /issues.
 */
export async function issuesFetch(
	request: Request,
	env: IssuesEnv,
	ctx: WaitUntil,
	{ project, rest, auth }: { project: string; rest: string; auth: IssuesAuth },
): Promise<Response> {
	if (!PROJECT_NAME.test(project)) return json(404, { error: "no such project" });
	if (!rest.startsWith("/")) return json(404, { error: "no such issues route" });
	const m = /^\/a\/([^/]+)\//.exec(rest);
	let agent: string | undefined;
	if (m) {
		try {
			agent = decodeURIComponent(m[1]!);
		} catch {
			return json(400, { error: "an agent's name is 1-64 of A-Z a-z 0-9 . _ -" });
		}
		if (!AGENT_NAME.test(agent)) return json(400, { error: "an agent's name is 1-64 of A-Z a-z 0-9 . _ -" });
	}
	const reading = request.method === "GET" || request.method === "HEAD";
	if (auth.kind === "key") {
		if (agent !== undefined && agent !== auth.agent)
			return json(403, { error: `this key is ${auth.agent}'s; it acts only as ${auth.agent}` });
		if (auth.role === "reader" && !reading) return json(403, { error: "a reader's key only reads issues" });
	}
	let body: Uint8Array<ArrayBuffer> | undefined;
	if (!reading) {
		try {
			body = await readCapped(request, BODY_MAX);
		} catch (e) {
			if (e instanceof IssuesError) return json(e.status, { error: e.message });
			throw e;
		}
	}
	// The object sees neither the token nor any header that could name a person.
	const headers = new Headers(request.headers);
	for (const h of ["Authorization", "X-Abso-User", "X-Avcs-User", "Cookie"]) headers.delete(h);
	const search = new URL(request.url).search;
	const forwarded = new Request(`https://issues.invalid/p/${encodeURIComponent(project)}${rest}${search}`, {
		method: request.method,
		headers,
		...(body !== undefined ? { body } : {}),
	});
	const stub = stubOf<{ fetch(request: Request): Promise<Response> }>(env.ISSUES_DO, project);
	const answer = await stub.fetch(forwarded);
	if (!reading && agent !== undefined && answer.ok) ctx.waitUntil(tell(env, project, agent, answer.clone()));
	return answer;
}

/** A write's news to the project object, sent after the answer. A failed send is only logged; the write stands. */
async function tell(env: IssuesEnv, project: string, from: string, answer: Response): Promise<void> {
	try {
		const { news } = (await answer.json()) as { news?: News };
		if (!news || typeof news.text !== "string") return;
		const hooks = hooksOf(env, project);
		if (hooks === undefined) {
			console.log(`issues: news for ${project} dropped: PROJECT isn't bound`);
			return;
		}
		await hooks.news!(project, [{ from, ...news }]);
	} catch (err) {
		if (missingMethod(err)) console.log(`issues: news for ${project} dropped: the project object has no news method`);
		else console.error(`issues: news for ${project} not sent`, err);
	}
}

/** The storage an IssueProject object has: its SQL, and a synchronous transaction. */
export interface ObjectStorage {
	sql: Sql;
	transactionSync<T>(action: () => T): T;
}

/** One project's issues: the store over the object's SQLite, migrated, and the routes over it. */
export class IssuesObject {
	readonly store: IssuesStore;
	private readonly storage: ObjectStorage;
	private readonly env: IssuesEnv;

	constructor(storage: ObjectStorage, env: IssuesEnv, now: () => number = Date.now) {
		this.storage = storage;
		this.env = env;
		this.migrate();
		this.store = new IssuesStore(storage.sql, now, (action) => storage.transactionSync(action));
	}

	/** Runs each SCHEMA statement not yet run, once, in order, each in its own transaction. */
	private migrate(): void {
		const sql = this.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS migrations (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
		const done = (sql.exec("SELECT COALESCE(MAX(n), 0) AS n FROM migrations").toArray()[0] as { n: number }).n;
		for (let n = done + 1; n <= SCHEMA.length; n++)
			this.storage.transactionSync(() => {
				sql.exec(SCHEMA[n - 1]!);
				sql.exec("INSERT INTO migrations (n, at) VALUES (?, ?)", n, Date.now());
			});
	}

	/** How many migrations this object has run. */
	migrations(): number {
		return (this.storage.sql.exec("SELECT COUNT(*) AS n FROM migrations").toArray()[0] as { n: number }).n;
	}

	async fetch(request: Request): Promise<Response> {
		const name = /^\/p\/([^/]+)\//.exec(new URL(request.url).pathname)?.[1];
		const project = name === undefined ? undefined : decodeURIComponent(name);
		const seatError = async (of: string): Promise<string | null> => {
			if (project === undefined) return null;
			const hooks = hooksOf(this.env, project);
			if (hooks === undefined) return null;
			let seats: string[];
			try {
				seats = await hooks.agents!(project);
			} catch (e) {
				if (missingMethod(e)) return null;
				throw e;
			}
			return Array.isArray(seats) ? seatRefusal(of, project, seats) : null;
		};
		return issuesRoute(this.store, request, seatError);
	}
}
