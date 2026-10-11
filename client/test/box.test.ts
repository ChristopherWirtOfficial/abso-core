// Signing in once per box (abso issue 108): login waits for approval and keeps
// the credential outside every project folder; it never shows up in output and
// only goes to the server that issued it.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import {
	boxPublic,
	boxText,
	forgetBox,
	login,
	loginRequest,
	logout,
	mintFreeName,
	mintKey,
	readBox,
	signedInServers,
	writeBox,
} from "../src/box.ts";
import { serverFrom } from "../src/join-commands.ts";
import { main } from "../src/main.ts";

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

test("login grant options validate project lists, roles, limits and duration", () => {
	const request = (...words: string[]) =>
		loginRequest(
			parseArgs("login", words, {
				projects: "string",
				role: "string",
				"max-agents": "string",
				days: "string",
			}),
		);
	assert.equal(request(), undefined);
	assert.deepEqual(request("--projects", "alpha, beta,alpha", "--max-agents", "1", "--days", "30"), {
		projects: [
			{ project: "alpha", role: "writer" },
			{ project: "beta", role: "writer" },
		],
		max_agents: 1,
		days: 30,
	});
	assert.deepEqual(request("--projects", "alpha", "--role", "reader"), {
		projects: [{ project: "alpha", role: "reader" }],
	});
	assert.deepEqual(request("--projects", "alpha", "--role", "owner"), {
		projects: [{ project: "alpha", role: "owner" }],
	});
	assert.deepEqual(request("--max-agents", "50", "--days", "90"), { max_agents: 50, days: 90 });
	for (const words of [
		["--role", "writer"],
		["--projects", ""],
		["--projects", "alpha,"],
		["--projects", "../alpha"],
		["--projects", "alpha", "--role", "admin"],
		["--projects", Array.from({ length: 101 }, (_, i) => `p${i}`).join(",")],
	])
		assert.throws(() => request(...words));
	for (const flag of ["--max-agents", "--days"]) {
		for (const value of ["0", "-1", "1.5", "1e1", "Infinity", "100", "abc", ""])
			assert.throws(() => request(flag, value));
	}
});

test("login sends requested grants only at device start and retains the user's actual approval", async () => {
	const h = home();
	const seen: Seen = [];
	const c = clock();
	const requested = { projects: [{ project: "abso", role: "owner" as const }], max_agents: 10, days: 90 };
	const approved = { projects: [{ project: "abso", role: "reader" }], max_agents: 1 };
	const got = await login(
		SERVER,
		{
			request: requested,
			fetch: server(
				[
					[200, started],
					[400, { error: "authorization_pending" }],
					[200, { box_id: "b_test", box_token: CREDENTIAL, expires_at: EXPIRES, grant: approved }],
				],
				seen,
			),
			sleep: c.sleep,
			now: c.now,
			say: () => {},
		},
		h,
	);
	assert.ok(seen[0]);
	assert.deepEqual((seen[0].body as Record<string, unknown>).requested_grant, requested);
	assert.deepEqual(
		seen.slice(1).map((call) => call.body),
		[{ device_code: started.device_code }, { device_code: started.device_code }],
	);
	assert.deepEqual(got.grant, approved);
	assert.deepEqual(readBox(SERVER, h)?.grant, approved);
});

test("invalid login grant flags fail before a network request through the CLI", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error("unexpected request");
	}) as typeof fetch;
	try {
		const result = await main(["login", "--projects", "alpha", "--days", "0", "--no-browser"], {
			cwd: home(),
			env: {},
			write: () => {},
		});
		assert.equal(result.exit, 1);
		assert.match(result.stderr, /--days is from 1 to 90/);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = original;
	}
});

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
		"Waiting for approval. Ctrl-C stops waiting, and abso stops by itself when the code runs out.",
	]);
	assert.equal(readBox(SERVER, h)?.credential, CREDENTIAL);
	const files = readdirSync(join(h, ".abso", "boxes"));
	assert.equal(files.length, 1);
	assert.ok(readFileSync(join(h, ".abso", "boxes", files[0]!), "utf8").includes(CREDENTIAL));
	assert.equal(boxText(got, SERVER, 0).includes(CREDENTIAL), false);
	assert.match(boxText(got, SERVER, 0), /abso \(writer\), game \(reader\)\. Up to 5 agents\./);
	assert.equal(JSON.stringify(boxPublic(got)).includes(CREDENTIAL), false);
});

test("login opens the approve page with the code in it, and prints the link and code all the same", async () => {
	const said: string[] = [];
	const opened: string[] = [];
	const c = clock();
	await login(
		SERVER,
		{
			fetch: server(
				[
					[200, started],
					[200, { box_id: "b_0123abcd", box_token: CREDENTIAL, expires_at: EXPIRES, grant }],
				],
				[],
			),
			sleep: c.sleep,
			now: c.now,
			say: (line) => said.push(line),
			open: (url) => (opened.push(url), true),
		},
		home(),
	);
	assert.deepEqual(opened, ["https://abso.dev/login/box?code=WXYZ-BCDF"]);
	assert.deepEqual(said.slice(0, 2), [
		"Opening the approve page in your browser.",
		"To sign this box in, open https://abso.dev/login/box?code=WXYZ-BCDF and approve the code WXYZ-BCDF.",
	]);
});

test("an open that doesn't start says nothing about a browser, and the printed link stands", async () => {
	const said: string[] = [];
	const c = clock();
	await login(
		SERVER,
		{
			fetch: server(
				[
					[200, started],
					[200, { box_id: "b_0123abcd", box_token: CREDENTIAL, expires_at: EXPIRES, grant }],
				],
				[],
			),
			sleep: c.sleep,
			now: c.now,
			say: (line) => said.push(line),
			open: () => false,
		},
		home(),
	);
	assert.equal(
		said[0],
		"To sign this box in, open https://abso.dev/login/box?code=WXYZ-BCDF and approve the code WXYZ-BCDF.",
	);
	assert.equal(
		said.some((l) => l.includes("browser")),
		false,
	);
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

test("login says it's still waiting about once a minute, and stops in the end whatever the server says", async () => {
	const c = clock();
	const said: string[] = [];
	const pending = Array.from({ length: 2000 }, (): [number, unknown] => [400, { error: "authorization_pending" }]);
	await assert.rejects(
		login(
			SERVER,
			{
				fetch: server([[200, { ...started, expires_in: 10 ** 9, interval: 5 }], ...pending], []),
				sleep: c.sleep,
				now: c.now,
				say: (line) => said.push(line),
			},
			home(),
		),
		/nobody approved the code WXYZ-BCDF in time\. Run abso login again\./,
	);
	assert.equal(c.slept(), 30 * 60 * 1000, "a server that says never still gets an end");
	const still = said.filter((line) => line === "Still waiting for the code WXYZ-BCDF to be approved.");
	assert.equal(still.length, 30);
	assert.equal(said.length, 2 + 30);
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

test("join and init pick the server: --server, ABSO_SERVER, the box's sign-in, then api.abso.dev", () => {
	const h = home();
	const args = (server?: string) => ({ positionals: [], flags: new Map(server ? [["server", server]] : []) });
	const none = { env: {} };
	assert.equal(serverFrom(args(), none, h), "https://api.abso.dev", "nothing signed in: the abso API");
	writeBox({ ...record, expiresAt: Date.now() + 1e6 }, h);
	assert.deepEqual(signedInServers(h), [SERVER]);
	assert.equal(serverFrom(args(), none, h), SERVER, "the server abso login signed this box in to");
	assert.deepEqual(signedInServers(h, Date.now() + 2e6), [], "an expired sign-in doesn't count");
	assert.equal(serverFrom(args(), { env: { ABSO_SERVER: "https://env.example" } }, h), "https://env.example");
	assert.equal(
		serverFrom(args("https://flag.example"), { env: { ABSO_SERVER: "https://env.example" } }, h),
		"https://flag.example",
	);
	writeBox({ ...record, server: "https://other.abso.example", expiresAt: Date.now() + 1e6 }, h);
	writeBox({ ...record, expiresAt: Date.now() + 1e6 }, h);
	assert.throws(
		() => serverFrom(args(), none, h),
		/signed in to https:\/\/other\.abso\.example and https:\/\/staging\.abso\.example: say which with --server/,
	);
	assert.equal(serverFrom(args(SERVER), none, h), SERVER, "--server settles it");
});

test("join with no --agent takes the box's name, skips names this box holds, and moves past a taken one", async () => {
	const seen: Seen = [];
	const fetcher = server(
		[
			[200, { box_id: record.id, agents: [{ project: "abso", agent: "snow", key_id: "k_0" }] }],
			[409, { error: "that agent name is already in use in this project; pick a new one" }],
			[200, { key: "abso_sk_new", id: "k_3" }],
		],
		seen,
	);
	const got = await mintFreeName(record, "abso", "snow", fetcher);
	assert.deepEqual(got, { key: "abso_sk_new", id: "k_3", agent: "snow-3" });
	assert.deepEqual(
		seen.map((s) => [new URL(s.url).pathname, (s.body as { agent?: string } | null)?.agent ?? null]),
		[
			["/box", null],
			["/box/agent-key", "snow-2"],
			["/box/agent-key", "snow-3"],
		],
		"snow is this box's already: never minted again, which would replace its key",
	);

	const limit = server(
		[
			[200, { box_id: record.id, agents: [] }],
			[409, { error: "this box is at its agent limit" }],
		],
		[],
	);
	await assert.rejects(mintFreeName(record, "abso", "snow", limit), /this box is at its agent limit \(5\)/);
});
