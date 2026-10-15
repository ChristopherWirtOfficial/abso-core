// The merge queue's checker loop (#39) on a real project, with the check as a
// function of the candidate's files: batches land whole, a failing batch is
// halved to the publish that turned it red, a failure must happen twice,
// box failures pause instead of blaming anyone, and a red shared lands only
// what passes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";
import { type Candidate, type Checker, type CheckResult, queueRound } from "../queue-driver.ts";

const AGENTS = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"];

function setup() {
	const project = new Project(new MemoryStore());
	project.checkerReady = true;
	const files: Record<string, string> = { "avcs.json": '{"queue": true}\n' };
	for (const a of AGENTS) files[`${a}.ts`] = `export const ${a} = 0;\n`;
	project.init(files, 0);
	for (const a of AGENTS) project.sync(a);
	return project;
}

/** Agent `a` publishes `value` into its own file; it must be queued. */
function queue(project: Project, a: string, value: string, time = 1): number {
	const e = project.edit(a, { file: `${a}.ts`, old: "= 0", new: `= ${value}` }, time);
	assert.ok(e.ok);
	const p = project.publish(a, `${a} is ${value}`, time);
	assert.ok(p.ok && "queued" in p, JSON.stringify(p));
	return p.queued;
}

/** A check that fails when any file says BAD, counting its runs. */
function checker(result?: (c: Candidate, run: number) => CheckResult): Checker & { runs: Candidate[] } {
	const runs: Candidate[] = [];
	return {
		runs,
		async check(c) {
			runs.push(c);
			if (result) return result(c, runs.length);
			return Object.values(c.files).some((t) => t.includes("BAD"))
				? { kind: "fail", output: "not ok 1 - BAD" }
				: { kind: "pass" };
		},
	};
}

test("an empty queue is idle and runs no check", async () => {
	const c = checker();
	assert.deepEqual(await queueRound(setup(), c), { kind: "idle" });
	assert.equal(c.runs.length, 0);
});

test("a passing batch lands whole, each push its own version, in one check", async () => {
	const project = setup();
	for (const a of AGENTS.slice(0, 3)) queue(project, a, "1");
	const c = checker();
	const r = await queueRound(project, c);
	assert.deepEqual(r, {
		kind: "landed",
		versions: [
			{ id: 1, version: 1 },
			{ id: 2, version: 2 },
			{ id: 3, version: 3 },
		],
		checks: 1,
	});
	assert.equal(project.treeAt(3), c.runs[0]!.tree);
	assert.deepEqual(project.queueChecking(0), []);
});

test("a batch is everything waiting, with no cap (Christopher, Oct 14): ten land on one check", async () => {
	const project = setup();
	for (const a of AGENTS) queue(project, a, "1");
	const c = checker();
	const r = await queueRound(project, c);
	assert.equal(r.kind === "landed" && r.versions.length, AGENTS.length);
	assert.deepEqual(
		c.runs.map((x) => x.ids.length),
		[AGENTS.length],
	);
	assert.deepEqual(project.queue().items, []);
});

test("a failing batch past the old cap of 8 still halves to the push that fails, and the rest waits", async () => {
	const project = setup();
	for (const [i, a] of AGENTS.entries()) queue(project, a, i === 8 ? '"BAD"' : "1");
	const c = checker();
	const r = await queueRound(project, c);
	assert.equal(c.runs[0]!.ids.length, AGENTS.length, "the first check is the whole queue");
	assert.ok(r.kind === "pulled");
	assert.deepEqual(r.pulled, [9]);
	assert.equal(r.versions.length, 8, "the eight before it land");
	assert.deepEqual(
		project.queue().items.map((q) => q.id),
		[10],
	);
});

test("a failing batch is halved to the first push that fails; the prefix before it lands, the rest waits", async () => {
	const project = setup();
	for (const [i, a] of AGENTS.slice(0, 8).entries()) queue(project, a, i === 5 ? '"BAD"' : "1");
	const c = checker();
	const r = await queueRound(project, c);
	// 8 fails; 4 passes; 6 fails; 5 passes; 6 fails again: 5 checks, 1 + log2(8) + 1.
	assert.deepEqual(
		c.runs.map((x) => x.ids.length),
		[8, 4, 6, 5, 6],
	);
	assert.equal(r.kind, "pulled");
	assert.ok(r.kind === "pulled");
	assert.deepEqual(
		r.versions.map((v) => v.id),
		[1, 2, 3, 4, 5],
	);
	assert.deepEqual(r.pulled, [6]);
	assert.equal(r.output, "not ok 1 - BAD");
	assert.deepEqual(
		project.queue().items.map((q) => q.id),
		[7, 8],
	);
	assert.ok(project.news("b6").news.some((n) => n.includes("not ok 1 - BAD")));
	assert.deepEqual(await queueRound(project, c), {
		kind: "landed",
		versions: [
			{ id: 7, version: 6 },
			{ id: 8, version: 7 },
		],
		checks: 1,
	});
});

test("a lone failing push is turned back after failing twice", async () => {
	const project = setup();
	queue(project, "b1", '"BAD"');
	const c = checker();
	const r = await queueRound(project, c);
	assert.equal(c.runs.length, 2);
	assert.ok(r.kind === "pulled" && r.pulled[0] === 1 && r.versions.length === 0);
});

test("a failure that does not happen again pulls nobody, and the prefix lands", async () => {
	const project = setup();
	for (const a of AGENTS.slice(0, 2)) queue(project, a, "1");
	// Fails once, then passes: flaky.
	const c = checker((_, run) => (run === 1 ? { kind: "fail", output: "flake" } : { kind: "pass" }));
	const r = await queueRound(project, c);
	// 2 fails; 1 passes; 2 passes on the confirming run, so both land.
	assert.deepEqual(r, {
		kind: "landed",
		versions: [
			{ id: 1, version: 1 },
			{ id: 2, version: 2 },
		],
		checks: 3,
	});
});

test("a box failure is retried once; twice in a row pauses the queue and blames nobody", async () => {
	const project = setup();
	queue(project, "b1", "1");
	const once = checker((_, run) => (run === 1 ? { kind: "box", reason: "box lost" } : { kind: "pass" }));
	assert.equal((await queueRound(project, once)).kind, "landed");
	queue(project, "b2", "1", 2);
	const always = checker(() => ({ kind: "box", reason: "no exit code" }));
	assert.deepEqual(await queueRound(project, always), { kind: "paused", reason: "no exit code", checks: 2 });
	assert.deepEqual(
		project.queue().items.map((q) => [q.id, q.checking]),
		[[2, false]],
	);
});

test("while shared is red, prefixes grow one push at a time; the first that passes lands, nobody is turned back", async () => {
	const project = setup();
	queue(project, "b1", "1");
	queue(project, "b2", "2");
	queue(project, "b3", "3");
	// Shared is red until b2's change is in: b1 alone doesn't fix it.
	const c = checker((cand) =>
		cand.files["b2.ts"]!.includes("= 2") ? { kind: "pass" } : { kind: "fail", output: "still red" },
	);
	assert.deepEqual(await queueRound(project, c, { sharedRed: true }), {
		kind: "landed",
		versions: [
			{ id: 1, version: 1 },
			{ id: 2, version: 2 },
		],
		checks: 2,
	});
	assert.deepEqual(
		c.runs.map((x) => x.ids),
		[[1], [1, 2]],
	);
	assert.deepEqual(
		project.queue().items.map((q) => q.id),
		[3],
	);
});

test("while shared is red and nothing fixes it, the queue holds everyone", async () => {
	const project = setup();
	queue(project, "b1", "1");
	queue(project, "b2", "2");
	const c = checker(() => ({ kind: "fail", output: "still red" }));
	assert.deepEqual(await queueRound(project, c, { sharedRed: true }), { kind: "held", checks: 2, output: "still red" });
	assert.deepEqual(
		project.queue().items.map((q) => q.id),
		[1, 2],
		"nobody turned back",
	);
});
