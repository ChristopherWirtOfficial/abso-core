// Which pipelines an event starts, and their jobs in waves (abso issue 176).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PipelineFile, readPipelineFile } from "../pipeline.ts";
import { plan, waves } from "../plan.ts";

const FILE = `pipelines:
  ci:
    on: [publish, draft]
    jobs:
      setup:  { run: npm ci }
      lint:   { needs: [setup], run: npx biome ci . }
      test:   { needs: [setup], run: npm test }
      bundle: { needs: [lint, test], run: npm run build, keep: ["dist/**"] }
    required: [lint, test]
  release:
    on: [green, hand]
    only: shared
    jobs:
      site: { uses: deploy, from: ci.bundle, worker: w, secrets: [CLOUDFLARE_API_TOKEN] }
      tell: { needs: [site], uses: notify, to: [issue] }
  nightly:
    on: [{ every: "day 06:00 UTC" }]
    jobs:
      drill: { run: node ops/restore-drill.ts }
`;
const read = (text: string): PipelineFile => {
	const c = readPipelineFile(text, "abso.yml");
	assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.problems));
	return c.file;
};
const file = read(FILE);
const started = (p: ReturnType<typeof plan>) => p.start.map((s) => s.name);

describe("which pipelines an event starts", () => {
	it("a publish to shared starts ci, in waves that can run side by side", () => {
		const p = plan(file, { kind: "publish", space: "shared" });
		assert.deepEqual(started(p), ["ci"]);
		assert.deepEqual(p.start[0]!.waves, [["setup"], ["lint", "test"], ["bundle"]]);
		assert.deepEqual(p.start[0]!.required, ["lint", "test"]);
		assert.deepEqual(p.skip, [
			{ name: "release", why: "doesn't run on publish" },
			{ name: "nightly", why: "doesn't run on publish" },
		]);
	});

	it("green on shared starts release; green on a named draft doesn't, since release is only shared", () => {
		assert.deepEqual(started(plan(file, { kind: "green", space: "shared" })), ["release"]);
		const p = plan(file, { kind: "green", space: "rename-59" });
		assert.deepEqual(started(p), []);
		assert.deepEqual(
			p.skip.find((s) => s.name === "release"),
			{ name: "release", why: "runs only for shared, not rename-59" },
		);
	});

	it("by hand starts only the pipeline named, and only if it runs by hand", () => {
		assert.deepEqual(started(plan(file, { kind: "hand", pipeline: "release", space: "shared" })), ["release"]);
		const ci = plan(file, { kind: "hand", pipeline: "ci", space: "shared" });
		assert.deepEqual(started(ci), []);
		assert.deepEqual(
			ci.skip.find((s) => s.name === "ci"),
			{ name: "ci", why: "doesn't run on hand" },
		);
	});

	it("a schedule starts the pipeline with that schedule, on shared", () => {
		assert.deepEqual(started(plan(file, { kind: "schedule", every: "day 06:00 UTC" })), ["nightly"]);
		assert.deepEqual(started(plan(file, { kind: "schedule", every: "hour" })), []);
	});

	it("a draft never starts a pipeline holding secrets, even if the file said so", () => {
		const unchecked: PipelineFile = {
			defaults: {},
			pipelines: [{ ...file.pipelines[1]!, on: ["draft"], only: undefined } as never],
		};
		const p = plan(unchecked, { kind: "draft", space: "shared" });
		assert.deepEqual(p.start, []);
		assert.match(p.skip[0]!.why, /holds secrets, and a draft runs unpublished code/);
	});

	it("waves stop on jobs that wait on each other rather than loop", () => {
		const job = (name: string, needs: string[]) =>
			({ name, needs, keep: [], cache: [], secrets: [], with: {} }) as never;
		assert.throws(() => waves([job("a", ["b"]), job("b", ["a"])]), /jobs a, b wait on each other/);
	});
});
