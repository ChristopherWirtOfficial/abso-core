// The Worker's way into issues: a key acts only as its own agent, a reader's key only reads, an ask goes only to
// the project's agents, and a write's news reaches the project object. Each IssueProject is an IssuesObject over
// node:sqlite, reached through fake namespaces shaped like Cloudflare's.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	type IssueNews,
	type IssuesAuth,
	type IssuesEnv,
	IssuesObject,
	issuesFetch,
	type ProjectHooks,
} from "../../src/issues/serve.ts";
import { SCHEMA } from "../../src/issues/store.ts";

function storage() {
	const db = new DatabaseSync(":memory:");
	return {
		sql: {
			exec: (q: string, ...b: unknown[]) => {
				if (/^\s*CREATE\b/i.test(q)) {
					db.exec(q);
					return { toArray: () => [] };
				}
				const rows = db.prepare(q).all(...(b as (string | number | null)[]));
				return { toArray: () => rows };
			},
		},
		transactionSync: <T>(action: () => T): T => {
			db.exec("SAVEPOINT t");
			try {
				const out = action();
				db.exec("RELEASE t");
				return out;
			} catch (e) {
				db.exec("ROLLBACK TO t");
				db.exec("RELEASE t");
				throw e;
			}
		},
	};
}

/** A namespace like Cloudflare's: idFromName gives the name back, get gives one object per name. */
function namespace<T extends object>(make: (name: string) => T) {
	const made = new Map<string, T>();
	return {
		idFromName: (name: string) => name,
		get: (id: never) => {
			const name = id as unknown as string;
			if (!made.has(name)) made.set(name, make(name));
			return made.get(name)!;
		},
	};
}

function world(hooks?: ProjectHooks) {
	const env: IssuesEnv = { ISSUES_DO: namespace(() => new IssuesObject(storage(), env)) };
	if (hooks) env.PROJECT = namespace(() => hooks);
	const waits: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
	const call = async (auth: IssuesAuth, method: string, rest: string, body?: unknown, project = "web") => {
		const r = await issuesFetch(
			new Request(`https://abso.example/issues/p/${project}${rest}`, {
				method,
				headers: { Authorization: "Bearer secret" },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}),
			env,
			ctx,
			{ project, rest: rest.replace(/\?.*$/, ""), auth },
		);
		await Promise.all(waits.splice(0));
		return { status: r.status, json: (await r.json()) as Record<string, any> };
	};
	return { env, call };
}

const token: IssuesAuth = { kind: "token" };
const leadKey: IssuesAuth = { kind: "key", agent: "lead", role: "writer" };
const readerKey: IssuesAuth = { kind: "key", agent: "watcher", role: "reader" };

describe("issuesFetch: who may do what", () => {
	it("the token acts as any agent; a key only as its own", async () => {
		const { call } = world();
		assert.equal((await call(token, "POST", "/a/fay/issue", { title: "Sync is slow" })).status, 200);
		assert.equal((await call(leadKey, "POST", "/a/lead/issue", { title: "Logo" })).status, 200);
		const other = await call(leadKey, "POST", "/a/fay/issue/1/comment", { text: "as fay" });
		assert.equal(other.status, 403);
		assert.match(other.json.error, /this key is lead's/);
		assert.equal((await call(leadKey, "GET", "/a/fay/waiting")).status, 403, "nor reads another's own list");
		assert.equal((await call(leadKey, "GET", "/issues")).json.issues.length, 2);
	});

	it("a reader's key reads and never writes", async () => {
		const { call } = world();
		await call(token, "POST", "/a/fay/issue", { title: "Sync is slow" });
		assert.equal((await call(readerKey, "GET", "/issue/1")).status, 200);
		assert.equal((await call(readerKey, "GET", "/search?q=sync")).json.hits.length, 1);
		const refused = await call(readerKey, "POST", "/a/watcher/issue/1/comment", { text: "hi" });
		assert.equal(refused.status, 403);
		assert.match(refused.json.error, /only reads/);
	});

	it("refuses a bad project or agent name, and an empty rest", async () => {
		const { call } = world();
		assert.equal((await call(token, "GET", "/issues", undefined, "no/such")).status, 404);
		assert.equal((await call(token, "POST", "/a/person:u1/issue", { title: "x" })).status, 400);
		assert.equal((await call(token, "GET", "")).status, 404);
	});

	it("each project has its own issues", async () => {
		const { call } = world();
		await call(token, "POST", "/a/fay/issue", { title: "Web's" });
		assert.equal((await call(token, "GET", "/issues", undefined, "other")).json.issues.length, 0);
	});

	it("attachments are 501, and a write naming one is refused before anything is written", async () => {
		const { call } = world();
		assert.equal((await call(token, "POST", "/a/fay/attachments")).status, 501);
		const named = await call(token, "POST", "/a/fay/issue", { title: "x", attachments: ["a0123456789ab"] });
		assert.equal(named.status, 501);
		assert.equal((await call(token, "GET", "/issues")).json.issues.length, 0);
	});
});

describe("issuesFetch: the project object", () => {
	it("an ask goes only to the project's agents", async () => {
		const { call } = world({ agents: async () => ["lead", "fay", "cloud"] });
		const refused = await call(token, "POST", "/a/lead/ask", { of: "Cloud Lead", question: "Which region?" });
		assert.equal(refused.status, 400);
		assert.match(refused.json.error, /isn't an agent in web, so nobody would hear the ask; did you mean cloud\?/);
		assert.equal((await call(token, "POST", "/a/lead/ask", { of: "cloud", question: "Which region?" })).status, 200);
	});

	it("without agents (or without PROJECT) the ask check is skipped", async () => {
		for (const hooks of [{}, undefined]) {
			const { call } = world(hooks);
			assert.equal((await call(token, "POST", "/a/lead/ask", { of: "anyone", question: "Q" })).status, 200);
		}
	});

	it("a write's news goes to the project from its writer; reads and refusals send none", async () => {
		const told: { project: string; items: IssueNews[] }[] = [];
		const { call } = world({
			news: async (project, items) => {
				told.push({ project, items });
				return [];
			},
		});
		await call(token, "POST", "/a/lead/issue", { title: "Sync is slow" });
		assert.equal(told.length, 0, "an issue for nobody in particular tells nobody");
		const asked = await call(token, "POST", "/a/lead/ask", { issue: 1, of: "fay", question: "Which way?" });
		assert.equal(told.length, 1);
		assert.equal(told[0]!.project, "web");
		assert.deepEqual(told[0]!.items, [
			{
				from: "lead",
				issue: 1,
				text: `lead asks fay a question on issue 1 ("Sync is slow"): "Which way?" Answer: abso answer ${asked.json.id} "..."`,
				to: ["fay"],
			},
		]);
		await call(token, "GET", "/issue/1");
		await call(token, "POST", "/a/lead/answer/1", { words: "not mine to answer" });
		assert.equal(told.length, 1);
	});

	it("news with no news method on the project is dropped, and the write stands", async () => {
		const { call } = world({ agents: async () => ["lead", "fay"] });
		const asked = await call(token, "POST", "/a/lead/ask", { of: "fay", question: "Which way?" });
		assert.equal(asked.status, 200);
		assert.equal((await call(token, "GET", "/a/fay/waiting")).json.asks.length, 1);
	});

	it("an agent reads its news and marks it read", async () => {
		const { call } = world();
		await call(token, "POST", "/a/fay/issue", { title: "Sync is slow" });
		await call(token, "POST", "/a/lead/ask", { issue: 1, of: "fay", question: "Which way?" });
		await call(token, "POST", "/a/fay/answer/1", { words: "live" });
		const news = await call(leadKey, "GET", "/a/lead/news");
		assert.deepEqual(
			news.json.news.map((n: { kind: string; text: string; read: boolean }) => [n.kind, n.text, n.read]),
			[["answer", "live", false]],
		);
		const marked = await call(leadKey, "POST", "/a/lead/news/read", {});
		assert.equal(marked.status, 200);
		assert.equal((await call(leadKey, "GET", "/a/lead/news")).json.news[0].read, true);
	});
});

describe("IssuesObject", () => {
	it("runs every migration once, and again runs none", () => {
		const s = storage();
		const env: IssuesEnv = { ISSUES_DO: namespace(() => ({})) };
		assert.equal(new IssuesObject(s, env).migrations(), SCHEMA.length);
		assert.equal(new IssuesObject(s, env).migrations(), SCHEMA.length);
	});

	it("names who wrote each text: the opener, then whoever last edited it", async () => {
		const { call } = world();
		await call(token, "POST", "/a/fay/issue", { title: "Sync", description: "slow" });
		await call(token, "POST", "/a/lead/issue/1/edit", { title: "Sync is slow" });
		await call(token, "POST", "/a/lead/issue/1/comment", { text: "seen it" });
		const page = (await call(token, "GET", "/issue/1")).json;
		assert.deepEqual(page.issue.authorship, {
			title: { kind: "agent", actor: "lead", provenance: "native", authorField: "edits.by" },
			description: { kind: "agent", actor: "fay", provenance: "native", authorField: "issues.opened_by" },
		});
		assert.equal(page.comments[0].authorship.actor, "lead");
		const hit = (await call(token, "GET", "/search?q=slow")).json.hits[0];
		assert.equal(hit.issue.authorship.title.actor, "lead");
	});
});
