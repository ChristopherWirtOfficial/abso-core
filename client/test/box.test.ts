// Signing in once per box (abso issue 108): login waits for approval and keeps
// the credential outside every project folder; it never shows up in output and
// only goes to the server that issued it.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxPublic, boxText, forgetBox, login, logout, mintKey, readBox, writeBox } from "../src/box.ts";

const SERVER = "https://staging.abso.example";
const CREDENTIAL = "abso_bx_the-secret-credential";
const grant = {
	projects: [
		{ project: "abso", role: "writer" },
		{ project: "game", role: "reader" },
	],
	max_agents: 5,
};
const EXPIRES = "2026-10-15T00:00:00.000Z";
const record = { server: SERVER, id: "b_0123abcd", credential: CREDENTIAL, grant, expiresAt: Date.parse(EXPIRES) };

const home = () => mkdtempSync(join(tmpdir(), "abso-box-"));

type Seen = { url: string; auth: string | null; body: unknown }[];
function server(answers: [number, unknown][], seen: Seen): typeof fetch {
	return (async (url, init) => {
		seen.push({
			url: String(url),
			auth: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(String(init?.body ?? "null")),
		});
		const [status, body] = answers.shift() ?? [500, { error: "no more answers" }];
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

const started = {
	device_code: "device-code-long-enough",
	user_code: "WXYZ-BCDF",
	verification_uri_complete: "https://abso.dev/login/box?code=WXYZ-BCDF",
	expires_in: 60,
	interval: 2,
};

function clock() {
	let t = 0;
	return {
		sleep: async (ms: number) => {
			t += ms;
		},
		now: () => t,
		slept: () => t,
	};
}

test("login shows the code, waits while it's pending, and keeps the credential in the user folder", async () => {
	const h = home();
	const seen: Seen = [];
	const said: string[] = [];
	const c = clock();
	const got = await login(
		`${SERVER}/some/path`,
		{
			fetch: server(
				[
					[200, started],
					[400, { error: "authorization_pending" }],
					[400, { error: "slow_down" }],
					[200, { box_id: "b_0123abcd", box_token: CREDENTIAL, expires_at: EXPIRES, grant }],
				],
				seen,
			),
			sleep: c.sleep,
			now: c.now,
			say: (line) => said.push(line),
		},
		h,
	);
	assert.equal(got.server, SERVER);
	assert.deepEqual(
		seen.map((s) => s.url),
		[`${SERVER}/login/device`, `${SERVER}/login/token`, `${SERVER}/login/token`, `${SERVER}/login/token`],
	);
	assert.deepEqual(seen[1]?.body, { device_code: "device-code-long-enough" });
	assert.equal(c.slept(), 2000 + 2000 + 7000, "slow_down adds 5 s to the wait");
	assert.ok(
		seen.every((s) => s.auth === null),
		"nothing is sent with login's calls",
	);
	assert.deepEqual(said, [
		"To sign this box in, open https://abso.dev/login/box?code=WXYZ-BCDF and approve the code WXYZ-BCDF.",
	]);
	assert.equal(readBox(SERVER, h)?.credential, CREDENTIAL);
	const files = readdirSync(join(h, ".abso", "boxes"));
	assert.equal(files.length, 1);
	assert.ok(readFileSync(join(h, ".abso", "boxes", files[0]!), "utf8").includes(CREDENTIAL));
	assert.equal(boxText(got, SERVER, 0).includes(CREDENTIAL), false);
	assert.match(boxText(got, SERVER, 0), /abso \(writer\), game \(reader\)\. Up to 5 agents\./);
	assert.equal(JSON.stringify(boxPublic(got)).includes(CREDENTIAL), false);
});

test("a code that's turned down or runs out says so and keeps nothing", async () => {
	const h = home();
	const c = clock();
	const io = { sleep: c.sleep, now: c.now, say: () => {} };
	await assert.rejects(
		login(
			SERVER,
			{
				...io,
				fetch: server(
					[
						[200, started],
						[400, { error: "access_denied" }],
					],
					[],
				),
			},
			h,
		),
		/was turned down/,
	);
	await assert.rejects(
		login(
			SERVER,
			{
				...io,
				fetch: server(
					[
						[200, started],
						[400, { error: "expired_token" }],
					],
					[],
				),
			},
			h,
		),
		/ran out\. Run abso login again/,
	);
	await assert.rejects(
		login(
			SERVER,
			{
				...io,
				fetch: server(
					[
						[200, { ...started, expires_in: 3 }],
						[400, { error: "authorization_pending" }],
						[400, { error: "authorization_pending" }],
					],
					[],
				),
			},
			h,
		),
		/in time\. Run abso login again/,
	);
	assert.equal(readBox(SERVER, h), undefined);
});

test("a key is minted with the box credential, sent only to the box's own server", async () => {
	const seen: Seen = [];
	const minted = await mintKey(
		record,
		"abso",
		"tester-1",
		server([[200, { key: "abso_sk_x", id: "k_0123abcd" }]], seen),
	);
	assert.deepEqual(minted, { key: "abso_sk_x", id: "k_0123abcd" });
	assert.equal(seen[0]?.url.startsWith(`${SERVER}/`), true);
	assert.equal(seen[0]?.auth, `Box ${CREDENTIAL}`);
	await assert.rejects(
		mintKey(record, "secret-project", "a", server([[403, { error: `outside the grant ${CREDENTIAL}` }]], [])),
		(e: Error) => /refused \(403\)/.test(e.message) && !e.message.includes(CREDENTIAL),
	);
});

test("a box's sign-in is kept per server, and logout forgets it even when the server is down", async () => {
	const h = home();
	writeBox(record, h);
	assert.equal(readBox("https://abso.example", h), undefined, "another server's box isn't this one");
	assert.match(boxText(undefined, SERVER), /isn't signed in/);
	const down = (async () => {
		throw new Error("offline");
	}) as typeof fetch;
	assert.equal(await logout(readBox(SERVER, h)!, down, h), false);
	assert.equal(readBox(SERVER, h), undefined);
	assert.equal(forgetBox(SERVER, h), false);
});
