// abso whoami and abso doctor: each check's line, the next step when one fails, the server asked as the box and as
// the folder's key, and no credential in anything printed. plainError's wording of the commonest failures.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/api-error.ts";
import { writeBox } from "../src/box.ts";
import { doctor, doctorText, nodeNeeded, type Probe, plainError, whoami } from "../src/doctor.ts";

const SERVER = "https://staging.abso.example";
const CREDENTIAL = "abso_bx_the-secret-credential";
const KEY = "abso_sk_the-secret-key";
const NOW = Date.parse("2026-10-10T06:00:00.000Z");
const grant = { projects: [{ project: "game", role: "writer" }], max_agents: 3 };
const box = (expiresAt = Date.parse("2026-10-20T00:00:00.000Z")) => ({
	server: SERVER,
	id: "b_0123abcd",
	credential: CREDENTIAL,
	grant,
	expiresAt,
});

const temp = (name: string) => mkdtempSync(join(tmpdir(), `abso-doctor-${name}-`));

function folder(): string {
	const root = temp("folder");
	mkdirSync(join(root, ".abso"));
	writeFileSync(
		join(root, ".abso", "config.json"),
		JSON.stringify({ server: SERVER, project: "game", agent: "builder" }),
	);
	writeFileSync(join(root, ".abso", "key"), JSON.stringify({ server: SERVER, key: KEY, id: "k_00c0ffee" }));
	return root;
}

type Seen = { url: string; auth: string | null }[];
/** A server answering by path: /version, /box, /p/game/head. A missing path throws, like a refused connection. */
function server(answers: Record<string, [number, unknown]>, seen: Seen = []): typeof fetch {
	return (async (url, init) => {
		const u = new URL(String(url));
		seen.push({ url: u.pathname, auth: new Headers(init?.headers).get("authorization") });
		const answer = answers[u.pathname];
		if (!answer)
			throw Object.assign(new TypeError("fetch failed"), {
				cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
			});
		return new Response(JSON.stringify(answer[1]), { status: answer[0] });
	}) as typeof fetch;
}

const probe = (fetcher: typeof fetch, home: string, node = "24.7.0", built = false): Probe => ({
	fetcher,
	now: NOW,
	node,
	built,
	home,
});
const accepted = { box_id: "b_0123abcd", revoked_at: null, approved_by: "christopher", grant };

test("the npm package needs Node 20; a checkout, which runs its .ts as is, needs 24", () => {
	assert.equal(nodeNeeded(true), 20);
	assert.equal(nodeNeeded(false), 24);
});

test("doctor outside a folder with no sign-in: the box check fails with abso login, the folder check doesn't apply", async () => {
	const checks = await doctor(
		SERVER,
		temp("outside"),
		{},
		probe(server({ "/version": [200, { commit: "ff7cd0e1" }] }), temp("home")),
	);
	assert.deepEqual(
		checks.map((c) => [c.check, c.result]),
		[
			["node", "ok"],
			["server", "ok"],
			["box", "fail"],
			["folder", "skip"],
		],
	);
	assert.match(checks[1]!.text, /answers \(version ff7cd0e\)/);
	assert.match(checks[2]!.text, /isn't signed in to https:\/\/staging\.abso\.example\. Run abso login\./);
	assert.match(checks[3]!.text, /abso join <project> makes one/);
});

test("doctor in a folder, signed in: every check passes, the box and the key each go to their own check", async () => {
	const home = temp("home");
	writeBox(box(), home);
	const seen: Seen = [];
	const checks = await doctor(
		SERVER,
		folder(),
		{},
		probe(
			server({ "/version": [200, { commit: "ff7cd0e" }], "/box": [200, accepted], "/p/game/head": [200, {}] }, seen),
			home,
		),
	);
	assert.deepEqual(
		checks.map((c) => c.result),
		["ok", "ok", "ok", "ok"],
	);
	assert.match(checks[3]!.text, /agent builder in game, with the agent key k_00c0ffee, which the server accepts/);
	assert.deepEqual(seen, [
		{ url: "/version", auth: null },
		{ url: "/box", auth: `Box ${CREDENTIAL}` },
		{ url: "/p/game/head", auth: `Bearer ${KEY}` },
	]);
	const text = doctorText(checks);
	assert.ok(!text.includes(CREDENTIAL) && !text.includes(KEY));
	assert.match(text, /^ok {4}Node 24\.7\.0/);
});

test("doctor when the server can't be reached: says so with the next step, and the checks that need it don't apply", async () => {
	const home = temp("home");
	writeBox(box(), home);
	const checks = await doctor(SERVER, folder(), {}, probe(server({}), home));
	assert.deepEqual(
		checks.map((c) => c.result),
		["ok", "fail", "skip", "skip"],
	);
	assert.match(
		checks[1]!.text,
		/Can't reach https:\/\/staging\.abso\.example: the connection was refused\. Check your connection, and the server in \.abso\/config\.json\./,
	);
});

test("doctor when the server refuses the box and the key: each fails with what to do", async () => {
	const home = temp("home");
	writeBox(box(), home);
	const checks = await doctor(
		SERVER,
		folder(),
		{},
		probe(
			server({
				"/version": [200, {}],
				"/box": [200, { ...accepted, revoked_at: NOW - 1000 }],
				"/p/game/head": [401, { error: "missing or wrong token" }],
			}),
			home,
		),
	);
	assert.deepEqual(
		checks.map((c) => c.result),
		["ok", "ok", "fail", "fail"],
	);
	assert.match(checks[2]!.text, /no longer accepts this box's sign-in \(signed out or revoked\)\. Run abso login\./);
	assert.match(checks[3]!.text, /didn't accept the agent key k_00c0ffee for game.*abso join game again/);
});

test("doctor: an expired sign-in and an old Node fail without asking the server about them", async () => {
	const home = temp("home");
	writeBox(box(NOW - 60_000), home);
	const seen: Seen = [];
	const checks = await doctor(
		SERVER,
		temp("outside"),
		{},
		probe(server({ "/version": [200, {}] }, seen), home, "20.11.0", false),
	);
	assert.equal(checks[0]!.result, "fail");
	assert.match(checks[0]!.text, /Node 20\.11\.0 is too old: abso needs 24 or later\./);
	assert.equal(checks[2]!.result, "fail");
	assert.match(checks[2]!.text, /expired 2026-10-10 05:59 UTC\. Run abso login\./);
	assert.deepEqual(
		seen.map((s) => s.url),
		["/version"],
	);
});

test("whoami: the box as the server sees it, who approved it, and this folder's agent and key, never a credential", async () => {
	const home = temp("home");
	writeBox(box(), home);
	const out = await whoami(SERVER, folder(), {}, probe(server({ "/box": [200, accepted] }), home));
	assert.match(
		out.text,
		/^Signed in to https:\/\/staging\.abso\.example as box b_0123abcd, approved by christopher\.\n/,
	);
	assert.match(out.text, /Projects: game \(writer\)\. Up to 3 agents\./);
	assert.match(
		out.text,
		/This folder is agent builder in project game on https:\/\/staging\.abso\.example, with the agent key k_00c0ffee\./,
	);
	assert.ok(!JSON.stringify(out).includes(CREDENTIAL) && !JSON.stringify(out).includes(KEY));
	assert.equal((out.json.box as { confirmed: boolean }).confirmed, true);
});

test("whoami signed out, outside a folder: the next step for each", async () => {
	const out = await whoami(SERVER, temp("outside"), {}, probe(server({}), temp("home")));
	assert.equal(
		out.text,
		"This box isn't signed in to https://staging.abso.example. Run abso login.\nYou're not in an abso folder. abso join <project> makes one.",
	);
});

test("whoami when the server says the box is revoked", async () => {
	const home = temp("home");
	writeBox(box(), home);
	const out = await whoami(
		SERVER,
		temp("outside"),
		{},
		probe(server({ "/box": [401, { error: "missing or wrong token" }] }), home),
	);
	assert.match(out.text, /no longer accepts this box's sign-in \(signed out or revoked\)\. Run abso login\./);
});

test("plainError words a refusal by whether a credential went, and a server that can't be reached", () => {
	const refused = new ApiError("GET /status answered 401: missing or wrong token", 401);
	assert.equal(plainError(refused, false), "You're not signed in. Run abso login, then abso join <project>.");
	assert.match(plainError(refused, true)!, /^The server didn't accept this folder's key.*abso doctor checks it/);
	assert.equal(
		plainError(new ApiError("could not reach https://api.abso.dev: connect ECONNREFUSED"), true),
		"Can't reach https://api.abso.dev: connect ECONNREFUSED. Check your connection; abso doctor checks the rest.",
	);
	assert.equal(
		plainError(
			new ApiError("could not reach http://x: refused. Nothing was published. Run the same command again."),
			true,
		),
		"Can't reach http://x: refused. Nothing was published. Run the same command again.",
	);
	assert.equal(plainError(new ApiError("GET /log answered 500: boom", 500), true), undefined);
	assert.equal(plainError(new Error("anything else"), true), undefined);
});
