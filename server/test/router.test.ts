import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Env } from "../src/env.ts";
import { authorize, handle, ISSUES_ROUTE, PROJECT_ROUTE, sameSecret } from "../src/router.ts";

const TOKEN = "test-token-for-the-router";

/** A project namespace whose objects record every call and answer what each test needs. */
function fakeEnv(extra: Partial<Env> = {}) {
	const calls: { project: string; method: string; args: unknown[] }[] = [];
	const object = (project: string) =>
		new Proxy(
			{},
			{
				get:
					(_t, method: string) =>
					async (...args: unknown[]) => {
						calls.push({ project, method, args });
						if (method === "call") return { status: 200, body: { op: args[1], agent: args[2], body: args[3] } };
						if (method === "putBlob") return { status: 200, body: { stored: true } };
						if (method === "head") return { version: 3, at: "now" };
						if (method === "checkAgentKey")
							return { ok: true, id: "k_1", as: "key k_1", role: "writer", agent: "carol", dirty: false };
						if (method === "issueAgentKey") return { id: "k_2", key: "abso_sk_new", agent: args[0] };
						return null;
					},
			},
		);
	const env = {
		PROJECT: { idFromName: (n: string) => n, get: (id: string) => object(id) },
		ISSUES_DO: { idFromName: (n: string) => n, get: () => ({}) },
		ABSO_TOKEN: TOKEN,
		...extra,
	} as unknown as Env;
	return { env, calls };
}

const ctx = {} as ExecutionContext;
const noIssues = async () => new Response("issues", { status: 299 });
const request = (path: string, init: RequestInit & { token?: string | null } = {}) => {
	const { token = TOKEN, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
	return new Request(`http://abso.test${path}`, { ...rest, headers });
};

describe("routes", () => {
	it("matches the project's top routes and an agent's ops", () => {
		assert.deepEqual(PROJECT_ROUTE.exec("/p/game/status")?.slice(1, 3), ["game", "status"]);
		assert.deepEqual(PROJECT_ROUTE.exec("/p/game/a/alice/publish")?.slice(1), [
			"game",
			"a/alice/publish",
			"alice",
			"publish",
		]);
		assert.equal(PROJECT_ROUTE.exec("/p/game/change/12")?.[2], "change/12");
		assert.equal(PROJECT_ROUTE.exec("/p/game/a/alice/run"), null, "boxes are not on the open server");
		assert.equal(PROJECT_ROUTE.exec("/p/game/ci/log"), null, "nor CI's output");
		assert.equal(PROJECT_ROUTE.exec("/p/game/members"), null);
		assert.deepEqual(ISSUES_ROUTE.exec("/issues/p/game/issues/4")?.slice(1), ["game", "/issues/4"]);
		assert.deepEqual(ISSUES_ROUTE.exec("/issues/p/game")?.slice(1), ["game", undefined]);
	});

	it("sends an agent's op to the project's object, with the JSON body", async () => {
		const { env, calls } = fakeEnv();
		const res = await handle(
			request("/p/game/a/alice/publish", { method: "POST", body: JSON.stringify({ message: "why" }) }),
			env,
			ctx,
			noIssues,
		);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { op: "publish", agent: "alice", body: { message: "why" } });
		assert.equal(calls[0]?.project, "game");
	});

	it("reads take their query as the body, and a read refuses a POST-only op as a GET", async () => {
		const { env } = fakeEnv();
		const log = await handle(request("/p/game/log?limit=5"), env, ctx, noIssues);
		assert.deepEqual(await log.json(), { op: "log", body: { limit: "5" } });
		const publish = await handle(request("/p/game/a/alice/publish"), env, ctx, noIssues);
		assert.equal(publish.status, 405);
	});

	it("refuses a project name the engine wouldn't take", async () => {
		const { env, calls } = fakeEnv();
		const res = await handle(request("/p/..bad/status"), env, ctx, noIssues);
		assert.equal(res.status, 400);
		assert.equal(calls.length, 0);
	});

	it("answers head from the object, and ci and queue as empty", async () => {
		const { env } = fakeEnv();
		assert.deepEqual(await (await handle(request("/p/game/head"), env, ctx, noIssues)).json(), {
			version: 3,
			at: "now",
		});
		const ci = (await (await handle(request("/p/game/ci"), env, ctx, noIssues)).json()) as Record<string, unknown>;
		assert.equal(ci.red, null);
		assert.deepEqual(await (await handle(request("/p/game/queue"), env, ctx, noIssues)).json(), {
			items: [],
			paused: null,
		});
	});

	it("checks a blob's name before its bytes go anywhere", async () => {
		const { env, calls } = fakeEnv();
		const bad = await handle(request("/p/game/blobs/not-a-hash", { method: "PUT", body: "x" }), env, ctx, noIssues);
		assert.equal(bad.status, 400);
		const upper = await handle(
			request(`/p/game/blobs/${"A".repeat(64)}`, { method: "PUT", body: "x" }),
			env,
			ctx,
			noIssues,
		);
		assert.equal(upper.status, 400);
		assert.equal(calls.length, 0);
		const good = await handle(
			request(`/p/game/blobs/${"a".repeat(64)}`, { method: "PUT", body: "x" }),
			env,
			ctx,
			noIssues,
		);
		assert.equal(good.status, 200);
		assert.equal(calls[0]?.method, "putBlob");
	});

	it("hands /issues to the issues code with the rest of the path and who is calling", async () => {
		const { env } = fakeEnv();
		let seen: unknown;
		const res = await handle(request("/issues/p/game/issues?open=1"), env, ctx, async (_r, _e, _c, where) => {
			seen = where;
			return new Response("ok");
		});
		assert.equal(await res.text(), "ok");
		assert.deepEqual(seen, { project: "game", rest: "/issues", auth: { kind: "token" } });
	});

	it("gives the issues code a key's agent and role", async () => {
		const { env } = fakeEnv({ AGENT_KEYS: "on", KEY_HMAC_SECRET: "s" });
		let seen: unknown;
		await handle(request("/issues/p/game/issues", { token: "abso_sk_abc" }), env, ctx, async (_r, _e, _c, where) => {
			seen = where;
			return new Response("ok");
		});
		assert.deepEqual(seen, { project: "game", rest: "/issues", auth: { kind: "key", agent: "carol", role: "writer" } });
	});

	it("answers /version without a token", async () => {
		const { env } = fakeEnv({ ABSO_TOKEN: undefined });
		const res = await handle(request("/version", { token: null }), env, ctx, noIssues);
		assert.equal(res.status, 200);
	});
});

describe("auth", () => {
	it("refuses everything when no shared token is set", async () => {
		const { env, calls } = fakeEnv({ ABSO_TOKEN: undefined });
		const res = await handle(request("/p/game/status", { token: "anything" }), env, ctx, noIssues);
		assert.equal(res.status, 503);
		assert.match(((await res.json()) as { error: string }).error, /no ABSO_TOKEN/);
		const empty = await authorize(request("/p/game/status", { token: null }), { ...env, ABSO_TOKEN: "" });
		assert.ok(empty instanceof Response && empty.status === 503);
		assert.equal(calls.length, 0);
	});

	it("refuses a missing or wrong token, and takes the right one", async () => {
		const { env, calls } = fakeEnv();
		assert.equal((await handle(request("/p/game/status", { token: null }), env, ctx, noIssues)).status, 401);
		assert.equal((await handle(request("/p/game/status", { token: "wrong" }), env, ctx, noIssues)).status, 401);
		assert.equal((await handle(request("/p/game/status", { token: `${TOKEN}x` }), env, ctx, noIssues)).status, 401);
		assert.equal((await handle(request("/", { token: "wrong" }), env, ctx, noIssues)).status, 401);
		assert.equal(calls.length, 0);
		assert.equal((await handle(request("/p/game/status"), env, ctx, noIssues)).status, 200);
	});

	it("takes the token under its old name, AVCS_TOKEN", async () => {
		const { env } = fakeEnv({ ABSO_TOKEN: undefined, AVCS_TOKEN: TOKEN });
		assert.deepEqual(await authorize(request("/p/game/status"), env), { kind: "token" });
	});

	it("treats an agent key as a key only when keys are on", async () => {
		const off = fakeEnv();
		const refused = await authorize(request("/p/game/status", { token: "abso_sk_abc" }), off.env);
		assert.ok(refused instanceof Response && refused.status === 401);
		const on = fakeEnv({ AGENT_KEYS: "on", KEY_HMAC_SECRET: "s" });
		assert.deepEqual(await authorize(request("/p/game/status", { token: "abso_sk_abc" }), on.env), {
			kind: "key",
			presented: "abso_sk_abc",
		});
	});

	it("compares secrets whatever their lengths", async () => {
		assert.equal(await sameSecret("abc", "abc"), true);
		assert.equal(await sameSecret("abc", "abcd"), false);
		assert.equal(await sameSecret("", "abc"), false);
	});

	it("issues agent keys only with the admin token beside the shared one", async () => {
		const { env, calls } = fakeEnv({ AGENT_KEYS: "on", KEY_HMAC_SECRET: "s", ABSO_ADMIN_TOKEN: "admin-secret" });
		const path = "/admin/agent-keys?project=game&agent=carol";
		assert.equal((await handle(request(path, { method: "POST" }), env, ctx, noIssues)).status, 403);
		const wrong = request(path, { method: "POST", headers: { "x-abso-admin": "nope" } });
		assert.equal((await handle(wrong, env, ctx, noIssues)).status, 403);
		const key = request(path, { method: "POST", token: "abso_sk_abc", headers: { "x-abso-admin": "admin-secret" } });
		assert.equal((await handle(key, env, ctx, noIssues)).status, 401);
		assert.equal(calls.length, 0);
		const ok = request(path, { method: "POST", headers: { "x-abso-admin": "admin-secret" } });
		const res = await handle(ok, env, ctx, noIssues);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { id: "k_2", key: "abso_sk_new", agent: "carol" });
	});

	it("has no agent keys routes while keys are off", async () => {
		const { env } = fakeEnv({ ABSO_ADMIN_TOKEN: "admin-secret" });
		const res = await handle(
			request("/admin/agent-keys?project=game", { headers: { "x-abso-admin": "admin-secret" } }),
			env,
			ctx,
			noIssues,
		);
		assert.equal(res.status, 404);
	});
});
