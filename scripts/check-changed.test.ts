// check:changed's plan: what a change reaches, on this repo as it is.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script, no types
import { plan } from "./check-changed.mjs";

test("a changed source file brings in the test files that import it, through other files, and the typecheck", () => {
	const p = plan(["src/engine/text.ts"]);
	assert.equal(p.full, undefined);
	const files: string[] = p.tests[0].files;
	assert.ok(files.length > 0);
	assert.ok(files.every((f) => f.endsWith(".test.ts")));
	assert.ok(!files.includes("scripts/check-changed.test.ts"), "a test that doesn't reach the file stays out");
	assert.deepEqual(
		p.typechecks.map((c: { tsconfig: string }) => c.tsconfig),
		["tsconfig.json", "server/tsconfig.json"],
	);
	assert.deepEqual(p.lint, ["src/engine/text.ts"]);
});

test("a changed test file runs itself", () => {
	const p = plan(["scripts/check-changed.test.ts"]);
	assert.deepEqual(
		p.tests.map((t: { files: string[] }) => t.files),
		[["scripts/check-changed.test.ts"]],
	);
	assert.deepEqual(p.typechecks, [], "tsconfig.json doesn't include scripts/");
});

test("a change to setup runs the full check", () => {
	assert.deepEqual(plan(["src/engine/text.ts", "package.json"]).full, ["package.json"]);
	assert.deepEqual(plan(["tsconfig.json"]).full, ["tsconfig.json"]);
});

test("server changes include their tests and worker types", () => {
	const p = plan(["server/src/engine-project.ts"]);
	assert.ok(p.tests.flatMap((t: { files: string[] }) => t.files).includes("server/test/engine-project.test.ts"));
	assert.ok(p.typechecks.some((c: { tsconfig: string }) => c.tsconfig === "server/tsconfig.json"));
});
