// `abso pipeline check` (abso issue 147): the folder's pipeline file, read and
// checked with no server.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { main } from "../src/main.ts";
import { runsText, runText } from "../src/pipeline-commands.ts";

const base = mkdtempSync(join(tmpdir(), "abso-pipeline-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/** A fresh folder holding `files`. */
function folder(files: Record<string, string>): string {
	const dir = join(base, String(n++));
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}
const run = (cwd: string, ...argv: string[]) =>
	main(["pipeline", ...argv], { cwd, env: {}, write: () => {}, readStdin: () => "" } as never);

const GOOD = `pipelines:
  ci:
    on: [publish, draft]
    jobs:
      test: { needs: [setup], run: npm test }
      setup: { run: npm ci }
    required: [test]
`;

describe("abso pipeline check", () => {
	it("lists a good file's pipelines with each job after the jobs it needs", async () => {
		const r = await run(folder({ "abso.yml": GOOD }), "check");
		assert.equal(r.exit, 0, r.stderr);
		assert.equal(
			r.stdout,
			"abso.yml is fine: 1 pipeline, jobs in the order they run.\n  ci, on publish, draft:\n    setup: npm ci\n    test (required): npm test, after setup\n",
		);
	});

	it("lists each problem as <path>: <message>, and exits 1", async () => {
		const bad = `pipelines:
  release:
    on: [draft]
    jobs:
      a: { needs: [b], run: x }
      b: { needs: [a], run: y, colour: blue }
      ship: { uses: deploy, worker: w, secrets: [CLOUDFLARE_API_TOKEN] }
`;
		const r = await run(folder({ "abso.yml": bad }), "check");
		assert.equal(r.exit, 1);
		assert.match(r.stdout, /^abso\.yml has \d+ problems:\n/);
		assert.match(r.stdout, /\n {2}pipelines\.release\.jobs\.b\.colour: isn't a key here/);
		assert.match(r.stdout, /\n {2}pipelines\.release\.on: includes draft, but ship holds secrets/);
		assert.match(r.stdout, /\n {2}pipelines\.release\.jobs: needs go round in a cycle/);
	});

	it("answers --json as { ok, problems } or { ok, pipelines }", async () => {
		const bad = await run(folder({ "abso.yml": "pipelines: {}\n" }), "check", "--json");
		const b = JSON.parse(bad.stdout);
		assert.equal(b.ok, false);
		assert.deepEqual(b.problems, [{ path: "pipelines", message: "has no pipelines" }]);
		const good = JSON.parse((await run(folder({ "abso.yml": GOOD }), "check", "--json")).stdout);
		assert.equal(good.ok, true);
		assert.deepEqual(
			good.pipelines[0].jobs.map((j: { name: string }) => j.name),
			["setup", "test"],
		);
	});

	it("looks for abso.yml, abso.yaml, then avcs.json, and reads avcs.json's shorthand", async () => {
		const both = folder({ "abso.yaml": GOOD, "avcs.json": '{ "check": "npm test" }' });
		assert.match((await run(both, "check")).stdout, /^abso\.yaml is fine/);
		const only = await run(folder({ "avcs.json": '{ "setup": "npm ci", "check": "npm test" }' }), "check");
		assert.equal(only.exit, 0, only.stderr);
		assert.match(
			only.stdout,
			/^avcs\.json is fine: 1 pipeline.*\n {2}ci, on publish:\n {4}setup \(required\): npm ci\n {4}check \(required\): npm test, after setup\n$/s,
		);
	});

	it("reads a file named relative to where it's run", async () => {
		const dir = folder({});
		mkdirSync(join(dir, "ci"));
		writeFileSync(join(dir, "ci", "pipes.yml"), GOOD);
		assert.match((await run(dir, "check", "ci/pipes.yml")).stdout, /^pipes\.yml is fine/);
	});

	it("says which names it looked for when there's no file, and how to call it", async () => {
		const none = await run(folder({}), "check");
		assert.equal(none.exit, 1);
		assert.match(none.stderr, /no pipeline file in .*: looked for abso\.yml, abso\.yaml, abso\.json, avcs\.json/);
		assert.match((await run(folder({}), "check", "nope.yml")).stderr, /no file nope\.yml/);
		assert.match((await run(folder({}), "lint")).stderr, /abso pipeline check \[file\]/);
		assert.match((await run(folder({}))).stderr, /abso pipeline check \[file\]/);
	});
});

describe("the yaml package is loaded only by abso pipeline (abso issue 168)", () => {
	it("no other part of the client imports the reader or yaml at startup", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const src = new URL("../src/", import.meta.url);
		for (const name of readdirSync(src)) {
			if (!name.endsWith(".ts") || name === "pipeline-commands.ts") continue;
			const text = readFileSync(new URL(name, src), "utf8");
			assert.doesNotMatch(text, /^import [^;]*from "(yaml|[^"]*pipeline[^"]*)";/m, name);
		}
		const main = readFileSync(new URL("main.ts", src), "utf8");
		assert.match(main, /await import\("\.\/pipeline-commands\.ts"\)/);
	});
});

describe("abso pipeline check --on (abso issue 176)", () => {
	const FILE = `pipelines:
  ci:
    on: [publish, draft]
    jobs:
      setup: { run: npm ci }
      lint: { needs: [setup], run: lint }
      test: { needs: [setup], run: npm test }
    required: [test]
  release:
    on: [green, hand]
    only: shared
    jobs:
      site: { uses: deploy, worker: w, secrets: [CLOUDFLARE_API_TOKEN] }
`;
	it("says which pipelines a draft starts, in waves, and why the others don't", async () => {
		const r = await run(folder({ "abso.yml": FILE }), "check", "--on", "draft");
		assert.equal(r.exit, 0, r.stderr);
		assert.equal(
			r.stdout,
			"On draft in shared, 1 pipeline from abso.yml starts; jobs on one line can run side by side.\n  ci starts:\n    1. setup\n    2. lint, test (required)\n  release doesn't start: doesn't run on draft\n",
		);
	});

	it("takes the space, the pipeline started by hand, and answers --json", async () => {
		const dir = folder({ "abso.yml": FILE });
		assert.match(
			(await run(dir, "check", "--on", "green", "--space", "rename-59")).stdout,
			/^On green in rename-59, nothing in abso\.yml starts/,
		);
		const j = JSON.parse((await run(dir, "check", "--on", "hand", "--pipeline", "release", "--json")).stdout);
		assert.equal(j.ok, true);
		assert.deepEqual(j.event, { kind: "hand", pipeline: "release", space: "shared" });
		assert.deepEqual(j.start, [{ name: "release", waves: [["site"]], required: [] }]);
	});

	it("refuses an event it doesn't know, or one missing what it needs", async () => {
		const dir = folder({ "abso.yml": FILE });
		assert.match(
			(await run(dir, "check", "--on", "merge")).stderr,
			/--on is one of publish, draft, green, land, hand, schedule/,
		);
		assert.match((await run(dir, "check", "--on", "hand")).stderr, /--on hand takes --pipeline <name>/);
		assert.match((await run(dir, "check", "--on", "schedule")).stderr, /--on schedule takes --every/);
	});
});

describe("abso pipeline runs", () => {
	const now = Date.parse("2026-10-10T07:00:00Z");
	const t = (hm: string) => Date.parse(`2026-10-10T${hm}:00Z`);
	const summary = {
		id: 4,
		version: 4,
		event: "green",
		file: "abso.yml",
		started: t("06:45"),
		ended: t("06:46"),
		state: "planned",
		pipelines: [{ name: "npm", state: "planned" }],
	};

	it("lists the runs, newest first, one line each", () => {
		assert.equal(
			runsText([summary], now),
			"  run 4: version 4 (green, abso.yml), planned, 06:45 UTC to 06:46 UTC: npm planned\nabso pipeline runs <run> shows its jobs.\n",
		);
		assert.equal(runsText([], now), "No pipeline runs yet.\n");
	});

	it("shows a run's jobs with why each one stopped, and where a log is", () => {
		const text = runText(
			{
				...summary,
				jobs: [
					{ pipeline: "npm", job: "pack", needs: [], run: "npm pack", state: "passed", exit: 0, seconds: 5, log: true },
					{
						pipeline: "npm",
						job: "publish",
						needs: ["pack"],
						uses: "npm-publish",
						state: "planned",
						why: "not bound here",
					},
					{
						pipeline: "npm",
						job: "wait",
						needs: [],
						uses: "npm-publish",
						state: "running",
						npm: { phase: "wait" },
						since: t("06:50"),
					},
				],
			},
			now,
		);
		assert.equal(
			text,
			[
				"Run 4: version 4 (green, abso.yml), planned, 06:45 UTC to 06:46 UTC.",
				"  npm.pack (npm pack): passed, exit 0, 5 s",
				"      log: abso pipeline runs 4 --log npm.pack",
				"  npm.publish (uses npm-publish): planned, not bound here",
				"  npm.wait (uses npm-publish): running, npm wait, since 06:50 UTC",
				"",
			].join("\n"),
		);
	});

	it("takes a run number, and --log only with one", async () => {
		const dir = folder({});
		assert.match((await run(dir, "runs", "x")).stderr, /a run is a number/);
		assert.match((await run(dir, "runs", "--log", "npm.pack")).stderr, /--log needs a run/);
	});
});
