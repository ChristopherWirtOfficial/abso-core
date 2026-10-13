// Issues, asks and news for the open server: one IssueProject Durable Object per project (bound as ISSUES_DO,
// named by the project's name), reached through issuesFetch from the Worker's /issues/p/:project/... routes.
// The logic is in serve.ts, store.ts and routes.ts, which run under node --test without Cloudflare's runtime.
//
//   GET  /issues/p/:project/issues[?status=&agent=&parent=&label=&open=1]   issues, most recently updated first
//   GET  /issues/p/:project/issue/:n                                        one issue with its comments, edits and asks
//   GET  /issues/p/:project/search?q=[&limit=]                               full-text search
//   GET  /issues/p/:project/labels | changes | waiting[?of=] | ask/:n | asked?by= | answered?of=
//   GET  /issues/p/:project/a/:agent/waiting | asked | drafts | news[?before=]
//   POST /issues/p/:project/a/:agent/issue | ask | answer/:n | ack/:n | reply/:n | withdraw/:n
//   POST /issues/p/:project/a/:agent/issue/:n/comment | edit | drop | reopen | done
//   POST /issues/p/:project/a/:agent/draft | draft/:n/open | draft/:n/delete | news/read

import { DurableObject } from "cloudflare:workers";
import { type IssuesEnv, IssuesObject } from "./serve.ts";
import type { News } from "./store.ts";

export {
	type IssueNews,
	type IssuesAuth,
	type IssuesEnv,
	issuesFetch,
	type NamespaceLike,
	type ProjectHooks,
	type WaitUntil,
} from "./serve.ts";

/** One project's issues, in its own SQLite. */
export class IssueProject extends DurableObject<IssuesEnv> {
	private readonly issues: IssuesObject;

	constructor(ctx: DurableObjectState, env: IssuesEnv) {
		super(ctx, env);
		// The migrations are synchronous SQL, so they finish here, before the object takes any request.
		this.issues = new IssuesObject(
			{ sql: ctx.storage.sql, transactionSync: (action) => ctx.storage.transactionSync(action) },
			env,
		);
	}

	async fetch(request: Request): Promise<Response> {
		return this.issues.fetch(request);
	}

	/** A start note names the issue; `change` is the note's log position. A missing or closed issue is ignored. */
	async claim(agent: string, issue: number, change: number): Promise<void> {
		this.issues.store.claim(agent, issue, change);
	}

	/** The start note ended without finishing the issue. */
	async unclaim(agent: string, issue: number): Promise<void> {
		this.issues.store.unclaim(agent, issue);
	}

	/** publish --done finished the issue in `version`: done, and its news for the project to deliver. */
	async done(agent: string, issue: number, version: number): Promise<{ news?: News }> {
		return this.issues.store.done(agent, issue, version);
	}

	/** How many schema migrations this object has run. */
	async schema(): Promise<{ migrations: number }> {
		return { migrations: this.issues.migrations() };
	}
}
