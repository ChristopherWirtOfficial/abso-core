// A line's earlier changes (abso-core issue 20): why follows a line back
// through the changes that rewrote it, and marks the ones that only changed
// its formatting.

import assert from "node:assert/strict";
import { test } from "node:test";
import { why } from "../blame.ts";
import { MemoryStore, Project } from "../project.ts";
import { normalize, pairIn, trail } from "../trail.ts";

function setup(files: Record<string, string>) {
	const project = new Project(new MemoryStore());
	project.init(files, 0);
	for (const a of ["ann", "bob", "fmt"]) project.sync(a);
	return project;
}

function push(p: Project, agent: string, file: string, old: string, now: string, message: string, time: number) {
	p.sync(agent);
	p.edit(agent, { file, old, new: now }, time);
	return p.publish(agent, message, time + 1);
}

test("normalized text ignores whitespace, wrapping, quotes, trailing commas, line-end semicolons and lone arrow parentheses", () => {
	assert.equal(normalize(["const a = f('x', 1);"]), normalize(['const a = f("x", 1)']));
	assert.equal(normalize(["f(a, b)"]), normalize(["f(", "\ta,", "\tb,", ")"]));
	assert.equal(normalize(["xs.map((x) => x)"]), normalize(["xs.map(x => x)"]));
	assert.notEqual(normalize(["const n = 8;"]), normalize(["const n = 9;"]));
});

test("pairing: a rewrapped run pairs by its characters, a real edit by similarity, a new line with nothing", () => {
	assert.deepEqual(pairIn(["f(a, b);"], ["f(", "  a,", "  b,", ");"], 1), { index: 0, formatting: true });
	assert.deepEqual(pairIn(["const n = Math.min(8, w);"], ["const n = Math.min(cap ?? 8, w);"], 0), {
		index: 0,
		formatting: false,
	});
	assert.equal(pairIn(["const n = 8;"], ["// nothing like it at all, really"], 0), undefined);
	assert.equal(pairIn([], ["new"], 0), undefined);
});

test("why follows a line back past a reformat to the change that said what it does", () => {
	const p = setup({ "q.ts": "export function take(w: number) {\n\tconst n = Math.min(8, w);\n\treturn n;\n}\n" });
	push(p, "ann", "q.ts", "Math.min(8, w)", "Math.min(cap ?? 8, w)", "Cap the batch at 8, tunable per project", 10); // v1
	push(p, "bob", "q.ts", "\treturn n;\n", "\treturn n; // the count\n", "Say what n is", 20); // v2, beside it
	push(
		p,
		"fmt",
		"q.ts",
		"\tconst n = Math.min(cap ?? 8, w);\n",
		"    const n = Math.min(cap ?? 8, w)\n",
		"Reformat",
		30,
	); // v3

	const w = why(p, "q.ts", 2);
	assert.equal(w.text, "    const n = Math.min(cap ?? 8, w)");
	assert.deepEqual(
		w.trail.map((s) => [s.publish?.version, s.formatting, s.text]),
		[
			[3, true, "    const n = Math.min(cap ?? 8, w)"],
			[1, false, "\tconst n = Math.min(cap ?? 8, w);"],
			[0, false, "\tconst n = Math.min(8, w);"],
		],
	);
	assert.equal(w.trail[1]!.publish?.message, "Cap the batch at 8, tunable per project");
	assert.equal(w.trailMore, undefined);
});

test("a reformat that wraps one line onto several leads each piece back to it", () => {
	const p = setup({ "a.ts": "call(alpha, beta);\n" });
	push(p, "fmt", "a.ts", "call(alpha, beta);\n", "call(\n\talpha,\n\tbeta,\n);\n", "Wrap", 10); // v1
	const w = why(p, "a.ts", 3);
	assert.deepEqual(
		w.trail.map((s) => [s.publish?.version, s.formatting, s.text]),
		[
			[1, true, "\tbeta,"],
			[0, false, "call(alpha, beta);"],
		],
	);
});

test("why --at reads the line as shared had it at that version", () => {
	const p = setup({ "a.ts": "one\ntwo\n" });
	push(p, "ann", "a.ts", "one\n", "zero\none\n", "Add zero", 10); // v1
	assert.equal(why(p, "a.ts", 1, { version: 0 }).text, "one");
	assert.equal(why(p, "a.ts", 2).text, "one");
});

test("the trail stops after the most steps it may take, and says so", () => {
	const p = setup({ "a.ts": "v = 0\n" });
	for (let i = 1; i <= 4; i++) push(p, "ann", "a.ts", `v = ${i - 1}`, `v = ${i}`, `to ${i}`, i * 10);
	const view = p.sharedView();
	const line = view.lines("a.ts")[0]!.id;
	const t = trail(p.graph, view, "a.ts", line, 2);
	assert.equal(t.steps.length, 2);
	assert.equal(t.more, true);
	assert.equal(trail(p.graph, view, "a.ts", line).steps.length, 5);
});

test("code moved to another file in one push is followed back into the file it came from", () => {
	const p = setup({
		"big.ts": "export const keep = 1;\nexport function tide(level: number) {\n\treturn level * 2;\n}\n",
		"small.ts": "export const other = 1;\n",
	});
	push(p, "ann", "big.ts", "level * 2", "level * 3", "Tides run higher", 10); // v1
	// Moved as it is: the engine keeps the lines themselves, so their history comes along.
	p.sync("bob");
	const tide = "export function tide(level: number) {\n\treturn level * 3;\n}\n";
	p.edit("bob", { file: "big.ts", old: tide, new: "" }, 20);
	p.edit("bob", { file: "small.ts", old: "export const other = 1;\n", new: `export const other = 1;\n${tide}` }, 21);
	p.publish("bob", "Move tide to small.ts", 22); // v2
	assert.deepEqual(
		why(p, "small.ts", 3).trail.map((s) => [s.publish?.version, s.text]),
		[
			[1, "\treturn level * 3;"],
			[0, "\treturn level * 2;"],
		],
	);
	// Moved and reindented in one push: new lines, followed back by their code.
	p.sync("ann");
	const moved = tide.replaceAll("\t", "  ");
	p.edit("ann", { file: "small.ts", old: tide, new: "" }, 30);
	p.edit("ann", { file: "big.ts", old: "export const keep = 1;\n", new: `export const keep = 1;\n${moved}` }, 31);
	p.publish("ann", "Move tide back, two-space indent", 32); // v3
	const w = why(p, "big.ts", 3);
	assert.deepEqual(
		w.trail.map((s) => [s.publish?.version, s.formatting, s.movedFrom, s.text]),
		[
			[3, true, "small.ts", "  return level * 3;"],
			[1, false, undefined, "\treturn level * 3;"],
			[0, false, undefined, "\treturn level * 2;"],
		],
	);
	// A short line (a brace) is too common to follow.
	assert.equal(why(p, "big.ts", 4).trail.length, 1);
});
