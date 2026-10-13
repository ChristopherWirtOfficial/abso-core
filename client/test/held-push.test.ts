// A held push from end to end, as two agents meet it: alice and bob change
// the same line, bob's push is held, he pulls, settles and pushes again.
// What each step prints has to be true, and the record has to keep his reason.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { main } from "../src/main.ts";
import { type Fake, startFake } from "./fake-server.ts";

const TOKEN = "test-token-not-secret";
const ENV = { AVCS_TOKEN: TOKEN, AVCS_HOOK_FORCE: "1", AVCS_SERVERS_FILE: "no-servers.json" };
const POLICY = "# Store policy\n\nFree shipping on orders over $50.\nReturns accepted within 30 days.\n";
const HELD = "Lower free shipping to $35: half of abandoned carts were between $35 and $50";

let fake: Fake;
const dirs: string[] = [];
before(async () => {
	fake = await startFake(0, TOKEN);
});
after(async () => {
	await fake.close();
	for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
	const d = mkdtempSync(join(tmpdir(), "abso-held-"));
	dirs.push(d);
	return d;
}

async function run(cwd: string, ...argv: string[]): Promise<{ exit: number; out: string }> {
	const r = await main(argv, { cwd, env: ENV, write: () => {} });
	return { exit: r.exit, out: r.stdout + r.stderr };
}

let projects = 0;
/** alice pushes $75; bob's $35 push is held. Answers both folders and bob's held push. */
async function held(): Promise<{ alice: string; bob: string; refused: string }> {
	const name = `held${++projects}`;
	const alice = temp();
	writeFileSync(join(alice, "store-policy.md"), POLICY);
	assert.equal(
		(await run(alice, "init", "--server", fake.url, "--project", name, "--agent", "alice", "--as-is")).exit,
		0,
	);
	const bob = temp();
	assert.equal((await run(bob, "join", name, "--agent", "bob", "--server", fake.url)).exit, 0);
	writeFileSync(join(alice, "store-policy.md"), POLICY.replace("$50", "$75"));
	writeFileSync(join(bob, "store-policy.md"), POLICY.replace("$50", "$35"));
	const pushed = await run(alice, "push", "-m", "Raise free shipping to $75: shipping costs rose");
	assert.equal(pushed.exit, 0, pushed.out);
	const refused = await run(bob, "push", "-m", HELD);
	assert.equal(refused.exit, 2, refused.out);
	return { alice, bob, refused: refused.out };
}

const policy = (dir: string) => readFileSync(join(dir, "store-policy.md"), "utf8");

describe("a held push", () => {
	it("says what the pull really writes: a marker block where both changed the same lines", async () => {
		const { bob, refused } = await held();
		assert.doesNotMatch(refused, /no markers/);
		assert.match(refused, /Run abso pull: each of those files comes back holding both sides' lines/);
		assert.equal((await run(bob, "pull")).exit, 0);
		assert.match(policy(bob), /^<<<<<<< yours \(unpublished\)$/m, "the pull wrote a marker block");
	});

	for (const how of ["yours", "theirs", "both"] as const) {
		it(`why names the collision a line was kept from, settled --${how}`, async () => {
			const { alice, bob } = await held();
			assert.equal((await run(bob, "pull")).exit, 0);
			const settled = await run(bob, "settle", "store-policy.md", `--${how}`);
			assert.equal(settled.exit, 0, settled.out);
			const pushed = await run(bob, "push", "-m", `Settle: keep ${how}`);
			assert.equal(pushed.exit, 0, pushed.out);
			assert.equal((await run(alice, "pull")).exit, 0);
			const why = await run(alice, "why", "store-policy.md:3");
			assert.equal(why.exit, 0, why.out);
			assert.match(why.out, /It was kept when bob settled a collision between:\n {2}alice, version 1 by alice/);
			assert.match(why.out, new RegExp(`\\n {2}bob, a held push: "${HELD.replace(/\$/g, "\\$")}"`));
		});
	}

	it("keeps its message: why on the settling line shows it, and so do the change page and the news", async () => {
		const { alice, bob } = await held();
		assert.equal((await run(bob, "pull")).exit, 0);
		writeFileSync(join(bob, "store-policy.md"), POLICY.replace("$50", "$60"));
		const pushed = await run(bob, "push", "-m", "Settle with alice: meet at $60");
		assert.equal(pushed.exit, 0, pushed.out);
		const why = await run(bob, "why", "store-policy.md:3");
		assert.match(
			why.out,
			/It settled a collision between:\n {2}alice, version 1 by alice[^\n]*\n {2}bob, a held push: "/,
		);
		assert.ok(why.out.includes(HELD), why.out);
		const review = await run(alice, "review", "bob");
		assert.match(review.out, /Settled: store-policy\.md \(rewrote both sides, against alice's version 1\)\./);
		assert.ok(review.out.includes(`Refused 1 time on the way: lines (store-policy.md): "${HELD}"`), review.out);
		const news = await run(alice, "news");
		assert.ok(news.out.includes(`Its held push said: "${HELD}"`), news.out);
	});

	it("a pull doesn't drop the news of what a settle kept", async () => {
		const { alice, bob } = await held();
		assert.equal((await run(bob, "pull")).exit, 0);
		assert.equal((await run(bob, "settle", "store-policy.md", "--both")).exit, 0);
		assert.equal((await run(bob, "push", "-m", "Settle: keep both")).exit, 0);
		const pulled = await run(alice, "pull");
		assert.equal(pulled.exit, 0, pulled.out);
		const news = await run(alice, "news");
		assert.match(news.out, /bob settled its collision with your version 1 in store-policy\.md, pushing version 2/);
	});

	it("the change page says what a settle kept in words that read for each choice", async () => {
		for (const [how, said] of [
			["yours", "kept bob's"],
			["theirs", "kept alice's"],
			["both", "kept both"],
		] as const) {
			const { alice, bob } = await held();
			assert.equal((await run(bob, "pull")).exit, 0);
			assert.equal((await run(bob, "settle", "store-policy.md", `--${how}`)).exit, 0);
			assert.equal((await run(bob, "push", "-m", `Settle: keep ${how}`)).exit, 0);
			const review = await run(alice, "review", "bob");
			assert.ok(review.out.includes(`Settled: store-policy.md (${said}, against alice's version 1).`), review.out);
		}
	});
});
