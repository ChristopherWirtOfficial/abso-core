// Randomized: agents edit lines far enough apart that the engine's rule finds
// no collision. Every publish order must go through and give the same files,
// equal to doing all the edits to plain text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project } from "../project.ts";

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Plan {
	agent: string;
	start: number;
	end: number;
	lines: string[];
}

test("changes that do not collide give the same files in every publish order", () => {
	for (let seed = 1; seed <= 60; seed++) {
		const rand = rng(seed);
		const pick = (n: number): number => Math.floor(rand() * n);
		const count = 12 + pick(30);
		const base = Array.from({ length: count }, (_, i) => `line ${i}`);
		// Cut the file into regions with two untouched lines between them.
		const plans: Plan[] = [];
		let at = pick(3);
		let n = 0;
		while (at < count) {
			const len = pick(3); // 0 = pure insertion
			if (at + len > count) break;
			const lines = Array.from({ length: pick(3) + (len === 0 ? 1 : 0) }, (_, i) => `agent${n} new ${i}`);
			if (len > 0 || lines.length > 0) plans.push({ agent: `agent${n++}`, start: at, end: at + len, lines });
			at += len + 2 + pick(3);
		}
		if (plans.length < 2) continue;

		const expected = [...base];
		for (const p of [...plans].reverse()) expected.splice(p.start, p.end - p.start, ...p.lines);
		const expectedText = expected.length > 0 ? expected.join("\n") + "\n" : undefined;

		const orders = [plans.map((_, i) => i), plans.map((_, i) => plans.length - 1 - i)];
		for (let k = 0; k < 3; k++) orders.push([...orders[0]!].sort(() => rand() - 0.5));
		for (const order of orders) {
			const project = new Project(new MemoryStore());
			project.init({ "f.txt": base.join("\n") + "\n" }, 0);
			for (const p of plans) {
				project.sync(p.agent);
				const lines = [...base];
				lines.splice(p.start, p.end - p.start, ...p.lines);
				project.record(p.agent, { "f.txt": lines.join("\n") + "\n" }, 1);
			}
			for (const i of order) {
				const answer = project.publish(plans[i]!.agent, "m", 2);
				assert.equal(answer.ok, true, `seed ${seed}, order ${order}: ${JSON.stringify(answer)}`);
			}
			assert.equal(project.files()["f.txt"], expectedText, `seed ${seed}, order ${order}`);
		}
	}
});
