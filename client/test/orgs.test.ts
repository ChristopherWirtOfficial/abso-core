// abso orgs and abso org: reads as the person who approved the box's sign-in, and the changes say where the
// website makes them. The server here is a stand-in that answers the org routes' documented shapes.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.ts";
import { writeBox } from "../src/box.ts";
import { commandTable } from "../src/main.ts";
import { initInOrg, runOrg, runOrgs, siteOf } from "../src/orgs.ts";

const SERVER = "https://api.example.dev";
const CREDENTIAL = "abso_bx_test0000000000";

function signedIn(): string {
	const home = mkdtempSync(join(tmpdir(), "abso-orgs-"));
	writeBox(
		{
			server: SERVER,
			id: "box_1",
			credential: CREDENTIAL,
			grant: { projects: [{ project: "web", role: "writer" }] },
			expiresAt: Date.now() + 86_400_000,
		},
		home,
	);
	return home;
}

/** A stand-in server: answers from `routes` by path, and keeps what was asked. */
function server(routes: Record<string, { status: number; body: unknown }>) {
	const asked: { url: string; method: string; auth: string | null }[] = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(url));
		asked.push({
			url: String(url),
			method: init?.method ?? "GET",
			auth: new Headers(init?.headers).get("authorization"),
		});
		const r = routes[u.pathname] ?? { status: 404, body: { error: "no such route" } };
		return new Response(JSON.stringify(r.body), { status: r.status });
	}) as typeof fetch;
	return { fetcher, asked };
}

const args = (line: string[]) => parseArgs("org", line, commandTable().org!.flags);

describe("abso orgs", () => {
	it("lists yours with your role, and invitations waiting, reading with the box's sign-in", async () => {
		const home = signedIn();
		const s = server({
			"/orgs": {
				status: 200,
				body: {
					orgs: [
						{ name: "acme-labs", displayName: "Acme Labs", role: "owner" },
						{ name: "beta", displayName: "beta", role: "member" },
					],
					invitations: [{ id: "inv_1", org: "gamma", role: "member", expiresAt: "2026-10-16T10:00:00.000Z" }],
				},
			},
		});
		const out = await runOrgs(SERVER, { home, fetch: s.fetcher });
		assert.equal(
			out.text,
			[
				"Your organizations (2):",
				"  acme-labs (Acme Labs): owner",
				"  beta: member",
				"Invited to:",
				"  gamma as member, until 2026-10-16 10:00 UTC",
				"Accept them on the website, signed in: https://example.dev.",
			].join("\n"),
		);
		assert.deepEqual(s.asked, [{ url: `${SERVER}/orgs`, method: "GET", auth: `Box ${CREDENTIAL}` }]);
	});

	it("says so when the box isn't signed in, the sign-in isn't taken, or orgs aren't on", async () => {
		const empty = mkdtempSync(join(tmpdir(), "abso-orgs-"));
		await assert.rejects(runOrgs(SERVER, { home: empty, fetch: server({}).fetcher }), /abso login signs it in/);
		const home = signedIn();
		const expired = server({ "/orgs": { status: 401, body: { error: "missing or wrong token" } } });
		await assert.rejects(runOrgs(SERVER, { home, fetch: expired.fetcher }), /abso login renews it/);
		const off = server({ "/orgs": { status: 404, body: { error: "organizations aren't on here yet" } } });
		await assert.rejects(runOrgs(SERVER, { home, fetch: off.fetcher }), /api\.example\.dev: organizations aren't on/);
	});

	it("never prints the credential, even when the server echoes it", async () => {
		const home = signedIn();
		const s = server({ "/orgs": { status: 500, body: `oops ${CREDENTIAL}` } });
		await assert.rejects(runOrgs(SERVER, { home, fetch: s.fetcher }), (e: Error) => !e.message.includes(CREDENTIAL));
	});
});

describe("abso org <name>", () => {
	const acme = {
		name: "acme-labs",
		displayName: "Acme Labs",
		description: "We make labs.",
		role: "owner",
		membersCan: "write",
		whoMakesProjects: "members",
		members: [
			{ id: "cf-1", role: "owner", name: "sam", raised: [] },
			{ id: "cf-2", role: "member", name: null, raised: [{ project: "web", role: "owner" }] },
		],
		projects: ["api", "web"],
		invites: [{ id: "inv_2", role: "member", kind: "link", for: null, expiresAt: "2026-10-16T10:00:00.000Z" }],
	};

	it("shows its projects, people, settings and open invites to a member, never a person's id", async () => {
		const home = signedIn();
		const s = server({ "/orgs/acme-labs": { status: 200, body: acme } });
		const out = await runOrg(args(["acme-labs"]), SERVER, { home, fetch: s.fetcher });
		assert.equal(
			out.text,
			[
				"acme-labs (Acme Labs)",
				"  We make labs.",
				"You're an owner. Members can write every project; members make projects.",
				"Projects (2): api, web",
				"People (2):",
				"  sam: owner",
				"  (no name yet): member, raised to owner in web",
				"Open invites:",
				"  a link, as member, until 2026-10-16 10:00 UTC",
			].join("\n"),
		);
		assert.equal(out.text.includes("cf-"), false);
	});

	it("shows a non-member only what the org shows everyone", async () => {
		const home = signedIn();
		const s = server({
			"/orgs/acme-labs": { status: 200, body: { name: "acme-labs", displayName: "Acme Labs", description: null } },
		});
		const out = await runOrg(args(["acme-labs"]), SERVER, { home, fetch: s.fetcher });
		assert.equal(out.text, "acme-labs (Acme Labs)\nYou aren't a member, so its people and settings aren't shown.");
	});

	it("says when there's no such org", async () => {
		const home = signedIn();
		await assert.rejects(runOrg(args(["nope"]), SERVER, { home, fetch: server({}).fetcher }), /^.*nope: no such route/);
	});

	it("sends no change: each says where on the website it is made, and nothing reaches the server", async () => {
		const home = signedIn();
		const s = server({});
		const cases: [string[], RegExp][] = [
			[["acme-labs", "--invite", "sam"], /--invite is on acme-labs's People tab: https:\/\/example\.dev\/acme-labs\./],
			[["acme-labs", "--invite", "link"], /People tab/],
			[["acme-labs", "--role", "sam=owner"], /--role is on acme-labs's People tab/],
			[["acme-labs", "--remove", "jo"], /--remove is on/],
			[["acme-labs", "--leave"], /--leave is on acme-labs's People tab/],
			[["acme-labs", "--members", "read"], /--members is on acme-labs's Settings tab/],
			[["acme-labs", "--projects-by", "owners"], /--projects-by is on acme-labs's Settings tab/],
			[["new", "acme-labs", "--name", "Acme Labs"], /Make acme-labs at https:\/\/example\.dev\/orgs\/new\./],
		];
		for (const [line, said] of cases) {
			await assert.rejects(runOrg(args(line), SERVER, { home, fetch: s.fetcher }), said, line.join(" "));
			await assert.rejects(runOrg(args(line), SERVER, { home, fetch: s.fetcher }), /changed on the website for now/);
		}
		assert.deepEqual(s.asked, []);
	});

	it("takes one change at a time, and --as only with --invite", async () => {
		const home = signedIn();
		const s = server({});
		await assert.rejects(
			runOrg(args(["acme-labs", "--remove", "jo", "--leave"]), SERVER, { home, fetch: s.fetcher }),
			/one change at a time: --remove and --leave were given together/,
		);
		await assert.rejects(
			runOrg(args(["acme-labs", "--as", "owner"]), SERVER, { home, fetch: s.fetcher }),
			/--as goes with --invite/,
		);
		await assert.rejects(runOrg(args([]), SERVER, { home, fetch: s.fetcher }), /abso org <name>/);
	});
});

describe("the website for a server", () => {
	it("is the site api. serves, or the server itself", () => {
		assert.equal(siteOf("https://api.abso.dev"), "https://abso.dev");
		assert.equal(siteOf("https://staging.example.workers.dev/"), "https://staging.example.workers.dev");
		assert.equal(siteOf("http://localhost:8787"), "http://localhost:8787");
	});
});

describe("abso init --org", () => {
	it("says the project is made on the website for now, with the org as its owner", () => {
		assert.throws(
			() => initInOrg("acme-labs", SERVER),
			/made on the website for now: New project at https:\/\/example\.dev, with acme-labs as its owner/,
		);
	});
});
