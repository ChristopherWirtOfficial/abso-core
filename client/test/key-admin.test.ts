import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import {
	adminGoesTo,
	adminToken,
	issuedPublic,
	keyList,
	keyListText,
	keyNew,
	keyRevoke,
	type ListedKey,
} from "../src/key-admin.ts";

const config: Config = {
	server: "https://staging.abso.example",
	project: "demo",
	agent: "me",
	token: "shared-token",
};
const ADMIN = "admin-token-value";
// No server takes the admin token unless AVCS_ADMIN_SERVERS names it; these tests name staging's stand-in.
process.env.AVCS_ADMIN_SERVERS = "https://staging.abso.example";
const KEY = "abso_sk_this-is-the-secret-value";

function fetchOf(status: number, body: unknown, seen: { url?: string; headers?: Headers }[]): typeof fetch {
	return (async (url, init) => {
		seen.push({ url: String(url), headers: new Headers(init?.headers) });
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

test("the admin token is sent only to a server AVCS_ADMIN_SERVERS names", async () => {
	assert.equal(adminGoesTo("https://staging.abso.example"), false);
	assert.equal(adminGoesTo("https://staging.abso.example", "https://staging.abso.example"), true);
	assert.equal(adminGoesTo("https://abso.example", "https://staging.abso.example"), false);
	assert.equal(adminGoesTo("https://example.com", "https://example.com"), true);
	const seen: unknown[] = [];
	const previous = globalThis.fetch;
	globalThis.fetch = (async () => {
		seen.push(true);
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		await assert.rejects(
			keyNew({ ...config, server: "https://example.com" }, ADMIN, "tester-1"),
			/will not send the admin token/,
		);
		assert.equal(seen.length, 0);
	} finally {
		globalThis.fetch = previous;
	}
});

test("the key is left out unless printing was asked for", () => {
	const issued = { id: "k_ab12cd34", key: KEY, agent: "tester-1" };
	assert.equal(JSON.stringify(issuedPublic(issued, false)).includes(KEY), false);
	assert.equal(issuedPublic(issued, true).key, KEY);
});

test("the admin token comes from the environment, not from a file argument", () => {
	assert.equal(adminToken({ AVCS_ADMIN_TOKEN: ADMIN }), ADMIN);
	assert.throws(() => adminToken({}), /AVCS_ADMIN_TOKEN/);
});

test("key new sends the admin token as a header and returns the key once", async () => {
	const seen: { url?: string; headers?: Headers }[] = [];
	const previous = globalThis.fetch;
	globalThis.fetch = fetchOf(200, { id: "k_ab12cd34", key: KEY, agent: "tester-1" }, seen);
	try {
		const issued = await keyNew(config, ADMIN, "tester-1");
		assert.deepEqual(issued, { id: "k_ab12cd34", key: KEY, agent: "tester-1" });
		assert.equal(seen[0]!.headers!.get("x-avcs-admin"), ADMIN);
		assert.equal(seen[0]!.url!.includes(ADMIN), false);
		assert.equal(seen[0]!.url!.includes(KEY), false);
	} finally {
		globalThis.fetch = previous;
	}
});

test("key list never includes a key value", async () => {
	const row: ListedKey = {
		id: "k_ab12cd34",
		agent: "tester-1",
		issuedBy: "admin",
		at: 1_700_000_000_000,
		lastUsed: null,
		revokedAt: null,
	};
	const previous = globalThis.fetch;
	globalThis.fetch = fetchOf(200, { keys: [row], leaked: KEY }, []);
	try {
		const keys = await keyList(config, ADMIN);
		const printed = keyListText(keys);
		const dumped = JSON.stringify(keys);
		assert.equal(printed.includes(KEY), false);
		assert.equal(dumped.includes(KEY), false);
		assert.match(printed, /k_ab12cd34/);
	} finally {
		globalThis.fetch = previous;
	}
});

test("an error does not repeat the admin token or the key", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = fetchOf(403, { error: `refused ${ADMIN} ${KEY}` }, []);
	try {
		await assert.rejects(keyRevoke(config, ADMIN, "k_ab12cd34"), (err: Error) => {
			assert.equal(err.message.includes(ADMIN), false);
			assert.equal(err.message.includes(KEY), false);
			return true;
		});
	} finally {
		globalThis.fetch = previous;
	}
});
