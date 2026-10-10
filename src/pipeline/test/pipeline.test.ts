// The pipeline file's shape (abso issue 147): read from YAML or JSON, and
// refused with the place and why for cycles, unknown jobs, secrets a draft
// could reach, and keys nobody knows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { type Checked, checkPipelines, type Problem, readPipelineFile } from "../pipeline.ts";

/** The draft pipeline file, comments included. */
const DRAFT = `defaults: { image: node, size: standard }   # image: a menu or \`dockerfile: path\`
pipelines:
  ci:
    on: [publish, draft]          # every version of shared, and an agent's draft before it pushes
    jobs:
      setup:  { run: npm ci, cache: [package-lock.json] }
      lint:   { needs: [setup], run: npx biome ci . }
      test:   { needs: [setup], run: npm test, size: large }
      rust:   { needs: [setup], image: node+rust, run: cargo nextest run }
      bundle: { needs: [lint, test], run: npm run build, keep: ["dist/**"] }
    required: [lint, test]        # these passing makes a version green
  release:
    on: [green]
    only: shared                  # never a draft, so secrets can't leak through one
    jobs:
      site:
        uses: deploy
        from: ci.bundle
        worker: avcs-website
        staging: always
        live: { steps: [0, 10, 50, 100], hold: 2m, approve: auto, stop_if: errors_rise }
        secrets: [CLOUDFLARE_API_TOKEN]
      tell: { needs: [site], uses: notify, to: [issue, watchers] }
  nightly:
    on: [{ every: "day 06:00 UTC" }]
    jobs:
      restore-drill: { run: node ops/restore-drill.ts }
`;

const ok = (c: Checked) => {
	assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.problems, null, 2));
	return c.file;
};
const problems = (c: Checked): readonly Problem[] => {
	assert.ok(!c.ok, "the file was accepted");
	return c.problems;
};
/** Asserts some problem is at `at` and matches `message`. */
const has = (ps: readonly Problem[], at: string, message: RegExp) =>
	assert.ok(
		ps.some((p) => p.at === at && message.test(p.message)),
		`no problem at ${at} matching ${message}; got ${JSON.stringify(ps, null, 2)}`,
	);

/** A file with one pipeline `p` of the given jobs. */
const one = (jobs: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
	pipelines: { p: { on: ["publish"], jobs, ...rest } },
});

describe("reading the file", () => {
	it("reads the draft from YAML, with every pipeline, job and setting", () => {
		const file = ok(readPipelineFile(DRAFT, "abso.yml"));
		assert.deepEqual(file.defaults, { image: "node", size: "standard" });
		assert.deepEqual(
			file.pipelines.map((p) => p.name),
			["ci", "release", "nightly"],
		);
		const [ci, release, nightly] = file.pipelines;
		assert.deepEqual(ci!.on, ["publish", "draft"]);
		assert.deepEqual(ci!.required, ["lint", "test"]);
		assert.deepEqual(release!.only, ["shared"]);
		assert.deepEqual(nightly!.on, [{ every: "day 06:00 UTC" }]);
		const site = release!.jobs.find((j) => j.name === "site")!;
		assert.equal(site.uses, "deploy");
		assert.equal(site.from, "ci.bundle");
		assert.deepEqual(site.secrets, ["CLOUDFLARE_API_TOKEN"]);
		assert.equal(site.with.worker, "avcs-website");
		assert.deepEqual(ci!.jobs.find((j) => j.name === "rust")!.image, "node+rust");
	});

	it("reads the same file from JSON to the same result", () => {
		const yaml = ok(readPipelineFile(DRAFT, "abso.yml"));
		const json = ok(readPipelineFile(JSON.stringify(parse(DRAFT)), "avcs.json"));
		assert.deepEqual(json, yaml);
	});

	it("puts each job after the jobs it needs", () => {
		const file = ok(
			checkPipelines(
				one({
					d: { needs: ["b", "c"], run: "d" },
					c: { needs: ["a"], run: "c" },
					b: { needs: ["a"], run: "b" },
					a: { run: "a" },
				}),
			),
		);
		const names = file.pipelines[0]!.jobs.map((j) => j.name);
		for (const [before, after] of [
			["a", "b"],
			["a", "c"],
			["b", "d"],
			["c", "d"],
		])
			assert.ok(names.indexOf(before!) < names.indexOf(after!), names.join(","));
	});

	it("reads on as a key in YAML, not as true", () => {
		ok(readPipelineFile("pipelines:\n  p:\n    on: publish\n    jobs:\n      a: { run: x }\n", "abso.yaml"));
	});

	it("says where YAML or JSON breaks, and refuses a name it can't tell the format of", () => {
		has(
			problems(readPipelineFile("pipelines:\n  p:\n    on: [push\n", "abso.yml")),
			"file",
			/isn't valid YAML at line \d/,
		);
		has(problems(readPipelineFile("{ pipelines: ", "avcs.json")), "file", /isn't valid JSON/);
		has(problems(readPipelineFile("pipelines: {}", "pipeline.txt")), "file", /format can't be told/);
	});

	it("refuses a key given twice in YAML", () => {
		has(
			problems(
				readPipelineFile("pipelines:\n  p:\n    on: publish\n    on: draft\n    jobs: { a: { run: x } }\n", "abso.yml"),
			),
			"file",
			/isn't valid YAML/,
		);
	});

	it("leaves avcs.json's own CI keys alone, but not in abso.yml", () => {
		const doc = { setup: "npm ci", check: "npm test", whole: ["package-lock.json"], ...one({ a: { run: "x" } }) };
		ok(readPipelineFile(JSON.stringify(doc), "avcs.json"));
		ok(readPipelineFile(JSON.stringify(doc), "some/folder/avcs.json"));
		has(problems(readPipelineFile(JSON.stringify(doc), "abso.yml")), "setup", /isn't a key here/);
	});
});

describe("refusing", () => {
	it("a cycle in needs, naming its jobs once", () => {
		const ps = problems(
			checkPipelines(
				one({
					a: { needs: ["c"], run: "a" },
					b: { needs: ["a"], run: "b" },
					c: { needs: ["b"], run: "c" },
					d: { run: "d" },
				}),
			),
		);
		has(ps, "pipelines.p.jobs", /cycle: a → c → b → a/);
		assert.equal(ps.filter((p) => /cycle/.test(p.message)).length, 1);
	});

	it("a job that needs itself", () => {
		has(
			problems(checkPipelines(one({ a: { needs: ["a"], run: "a" } }))),
			"pipelines.p.jobs.a.needs[0]",
			/the job itself/,
		);
	});

	it("needs, required and from naming what doesn't exist", () => {
		const ps = problems(
			checkPipelines({
				pipelines: {
					p: {
						on: ["publish"],
						jobs: { a: { needs: ["nope"], run: "a" }, b: { needs: ["q.c"], run: "b" } },
						required: ["a", "missing"],
					},
					q: {
						on: ["green"],
						jobs: {
							c: { run: "c" },
							d: { run: "d", from: "p.ghost" },
							e: { run: "e", from: "none.c" },
							f: { run: "f", from: "p.a" },
							g: { run: "g", from: "justone" },
						},
					},
				},
			}),
		);
		has(ps, "pipelines.p.jobs.a.needs[0]", /job "nope", which this pipeline doesn't have/);
		has(
			ps,
			"pipelines.p.jobs.b.needs[0]",
			/reaches only jobs in this pipeline; take another pipeline's files with from/,
		);
		has(ps, "pipelines.p.required[1]", /job "missing"/);
		has(ps, "pipelines.q.jobs.d.from", /job "ghost", which pipeline "p" doesn't have/);
		has(ps, "pipelines.q.jobs.e.from", /pipeline "none", which doesn't exist/);
		has(ps, "pipelines.q.jobs.f.from", /keeps no files/);
		has(ps, "pipelines.q.jobs.g.from", /must be <pipeline>.<job>/);
	});

	it("secrets in a pipeline a draft can start", () => {
		const deploy = { uses: "deploy", worker: "w", secrets: ["CLOUDFLARE_API_TOKEN"] };
		const ps = problems(checkPipelines(one({ ship: deploy }, { on: ["publish", "draft"], only: "shared" })));
		has(ps, "pipelines.p.on", /includes draft, but ship holds secrets/);
		assert.equal(ps.length, 1, JSON.stringify(ps));
	});

	it("secrets in a pipeline that isn't only shared", () => {
		const deploy = { uses: "deploy", worker: "w", secrets: ["CLOUDFLARE_API_TOKEN"] };
		has(problems(checkPipelines(one({ ship: deploy }, { on: ["green"] }))), "pipelines.p.only", /must be shared/);
		has(
			problems(checkPipelines(one({ ship: deploy }, { on: ["green"], only: ["shared", "rename-59"] }))),
			"pipelines.p.only",
			/must be shared/,
		);
		ok(checkPipelines(one({ ship: deploy }, { on: ["green"], only: ["shared"] })));
		// Without secrets, a draft may run anything.
		ok(checkPipelines(one({ a: { run: "npm test" } }, { on: ["draft"] })));
	});

	it("npm-publish: the packages it may push, from a job's kept files", () => {
		const pack = { run: "npm pack --pack-destination out", keep: ["out"] };
		const read = checkPipelines(
			one({
				pack,
				publish: { uses: "npm-publish", from: "p.pack", needs: ["pack"], packages: ["@scope/tool", "tool"] },
			}),
		);
		ok(read);
		const job = read.ok ? read.file.pipelines[0]!.jobs.find((j) => j.name === "publish") : undefined;
		assert.equal(job?.uses, "npm-publish");
		assert.deepEqual(job?.with, { packages: ["@scope/tool", "tool"] });
		const ps = problems(
			checkPipelines(
				one({
					pack,
					a: { uses: "npm-publish", packages: ["tool"] },
					b: { uses: "npm-publish", from: "p.pack" },
					c: { uses: "npm-publish", from: "p.pack", packages: ["Tool", "@scope", 7] },
				}),
			),
		);
		has(ps, "pipelines.p.jobs.a.from", /is missing/);
		has(ps, "pipelines.p.jobs.b.packages", /is missing/);
		has(ps, "pipelines.p.jobs.c.packages[0]", /isn't an npm package name/);
		has(ps, "pipelines.p.jobs.c.packages[1]", /isn't an npm package name/);
		has(ps, "pipelines.p.jobs.c.packages[2]", /isn't an npm package name/);
	});

	it("abso: a run job may ask for a reader or writer key; a writer key only where secrets may go", () => {
		const read = checkPipelines(one({ a: { run: "abso status", abso: "reader" }, b: { run: "true" } }));
		ok(read);
		const jobs = read.ok ? read.file.pipelines[0]!.jobs : [];
		assert.equal(jobs.find((j) => j.name === "a")?.abso, "reader");
		assert.equal(jobs.find((j) => j.name === "b")?.abso, undefined);
		ok(checkPipelines(one({ a: { run: "abso push -m x", abso: "writer" } }, { only: ["shared"] })));
		const ps = problems(
			checkPipelines(
				one({
					a: { run: "x", abso: "owner" },
					b: { uses: "deploy", worker: "w", abso: "reader" },
					c: { run: "x", abso: "writer" },
				}),
			),
		);
		has(ps, "pipelines.p.jobs.a.abso", /must be reader or writer, not "owner"/);
		has(ps, "pipelines.p.jobs.b.abso", /a uses step runs on the server/);
		has(ps, "pipelines.p.only", /c holds a writer key and a named draft's version is no one's pushed work/);
		has(
			problems(checkPipelines(one({ c: { run: "x", abso: "writer" } }, { on: ["draft"], only: ["shared"] }))),
			"pipelines.p.on",
			/includes draft, but c holds a writer key/,
		);
		// A reader key is fine where a draft runs: it changes nothing.
		ok(checkPipelines(one({ a: { run: "abso status", abso: "reader" } }, { on: ["draft"] })));
	});

	it("npm-publish: an optional dist-tag", () => {
		const pack = { run: "npm pack --pack-destination out", keep: ["out"] };
		const read = checkPipelines(
			one({ pack, publish: { uses: "npm-publish", from: "p.pack", packages: ["tool"], tag: "next" } }),
		);
		ok(read);
		const job = read.ok ? read.file.pipelines[0]!.jobs.find((j) => j.name === "publish") : undefined;
		assert.deepEqual(job?.with, { packages: ["tool"], tag: "next" });
		const ps = problems(
			checkPipelines(
				one({
					pack,
					a: { uses: "npm-publish", from: "p.pack", packages: ["tool"], tag: "1.2.0" },
					b: { uses: "npm-publish", from: "p.pack", packages: ["tool"], tag: "Next" },
					c: { uses: "npm-publish", from: "p.pack", packages: ["tool"], tag: 7 },
				}),
			),
		);
		has(ps, "pipelines.p.jobs.a.tag", /isn't an npm dist-tag/);
		has(ps, "pipelines.p.jobs.b.tag", /isn't an npm dist-tag/);
		has(ps, "pipelines.p.jobs.c.tag", /isn't an npm dist-tag/);
	});

	it("keys it doesn't know, at every level", () => {
		const ps = problems(
			checkPipelines({
				defaults: { image: "node", colour: "blue" },
				pipelines: { p: { on: ["publish"], when: "always", jobs: { a: { run: "x", timeout: 5, worker: "w" } } } },
				extra: 1,
			}),
		);
		has(ps, "extra", /isn't a key here/);
		has(ps, "defaults.colour", /isn't a key here/);
		has(ps, "pipelines.p.when", /isn't a key here \(known: on, only, jobs, required\)/);
		has(ps, "pipelines.p.jobs.a.timeout", /isn't a key here/);
		// worker is deploy's own setting, not a run job's.
		has(ps, "pipelines.p.jobs.a.worker", /isn't a key here/);
	});

	it("a job that runs nothing, or two things, or an unknown step", () => {
		const ps = problems(
			checkPipelines(
				one({
					a: { needs: [] },
					b: { run: "x", uses: "notify" },
					c: { uses: "launch-rockets" },
					d: { uses: "deploy" },
					e: { run: "  " },
				}),
			),
		);
		has(ps, "pipelines.p.jobs.a", /needs run \(a command\) or uses/);
		has(ps, "pipelines.p.jobs.b", /both run and uses/);
		has(ps, "pipelines.p.jobs.c.uses", /must be one of deploy, preview, notify/);
		has(ps, "pipelines.p.jobs.d.worker", /is missing/);
		has(ps, "pipelines.p.jobs.e.run", /must be a command/);
	});

	it("triggers, names, sizes, machines and secret names it can't use", () => {
		const ps = problems(
			checkPipelines({
				defaults: { image: "node", dockerfile: "Dockerfile" },
				pipelines: {
					p: { on: ["publish", "sometimes", { every: "" }], jobs: { a: { run: "x", size: "huge" } } },
					Bad: { on: [], jobs: {} },
					s: { on: "green", only: "shared", jobs: { "x y": { uses: "deploy", worker: "w", secrets: ["token"] } } },
					t: { jobs: { a: { run: "x" } } },
				},
			}),
		);
		has(ps, "defaults", /both image and dockerfile/);
		has(ps, "pipelines.p.on[1]", /must be one of publish, draft, green, land, hand/);
		has(ps, "pipelines.p.on[2]", /every/);
		has(ps, "pipelines.p.jobs.a.size", /must be one of small, standard, large, not "huge"/);
		has(ps, "pipelines.Bad", /isn't a usable name/);
		has(ps, "pipelines.Bad.on", /is empty/);
		has(ps, "pipelines.Bad.jobs", /has no jobs/);
		has(ps, "pipelines.s.jobs.x y", /isn't a usable name/);
		has(ps, "pipelines.s.jobs.x y.secrets[0]", /isn't a secret name/);
		has(ps, "pipelines.t.on", /is missing/);
	});

	it("a file with no pipelines, or that isn't a map", () => {
		has(problems(checkPipelines({})), "pipelines", /is missing/);
		has(problems(checkPipelines({ pipelines: {} })), "pipelines", /has no pipelines/);
		has(problems(checkPipelines([1, 2])), "file", /must be a map/);
		has(problems(readPipelineFile("just words", "abso.yml")), "file", /must be a map/);
	});
});

describe("abso.json's shorthand for a ci pipeline", () => {
	it("reads the project's own abso.json as ci: setup, then check, both required, on publish", async () => {
		const { readFileSync } = await import("node:fs");
		const text = readFileSync(new URL("../../../abso.json", import.meta.url), "utf8");
		const own = JSON.parse(text);
		const [ci, ...rest] = ok(readPipelineFile(text, "abso.json")).pipelines;
		assert.equal(rest.length, 0);
		assert.equal(ci!.name, "ci");
		assert.deepEqual(ci!.on, ["publish"]);
		assert.deepEqual(
			ci!.jobs.map((j) => [j.name, j.run, j.needs]),
			[
				["setup", own.setup, []],
				["check", own.check, ["setup"]],
			],
		);
		assert.deepEqual(ci!.required, ["setup", "check"]);
	});

	it("runs build before check, as today's job does, keeping its out folder", () => {
		const doc = { setup: "npm ci", check: "npm test", build: "npm run build", out: "site/dist" };
		const [ci] = ok(readPipelineFile(JSON.stringify(doc), "avcs.json")).pipelines;
		assert.deepEqual(
			ci!.jobs.map((j) => [j.name, j.needs, j.keep]),
			[
				["setup", [], []],
				["build", ["setup"], ["site/dist/**"]],
				["check", ["build"], []],
			],
		);
		const [only] = ok(readPipelineFile(JSON.stringify({ build: "vite build" }), "avcs.json")).pipelines;
		assert.deepEqual(only!.jobs[0]!.keep, ["dist/**"]);
	});

	it("is only read from avcs.json with no pipelines beside it", () => {
		const both = { setup: "npm ci", check: "npm test", ...one({ a: { run: "x" } }) };
		assert.deepEqual(
			ok(readPipelineFile(JSON.stringify(both), "avcs.json")).pipelines.map((p) => p.name),
			["p"],
		);
		has(problems(readPipelineFile("setup: npm ci\ncheck: npm test\n", "abso.yml")), "setup", /isn't a key here/);
	});

	it("counts empty commands as none, and refuses commands and folders it can't use", () => {
		has(problems(readPipelineFile(JSON.stringify({ setup: "", check: " " }), "avcs.json")), "pipelines", /is missing/);
		const ps = problems(
			readPipelineFile(JSON.stringify({ check: ["npm", "test"], build: "b", out: "../up" }), "avcs.json"),
		);
		has(ps, "check", /must be a command/);
		has(ps, "out", /must be a folder under the project/);
	});
});
