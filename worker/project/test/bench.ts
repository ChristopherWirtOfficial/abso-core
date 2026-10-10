// Times the project's calls on a project of a given size, in this process
// (no network, no storage). Run: node worker/project/test/bench.ts [files] [lines] [defs|body]
// "defs" (the default) makes every line a definition, the worst case for the
// changed-definition rule; "body" makes them plain statements.

import { type Entry, MemoryStore, Project } from "../project.ts";

const fileCount = Number(process.argv[2] ?? 100);
const linesPer = Number(process.argv[3] ?? 200);
const kind = process.argv[4] === "body" ? "body" : "defs";
const lineOf = (f: number, i: number, extra = ""): string =>
	kind === "defs" ? `const v${f}_${i} = ${i}${extra};` : `  total${f} += ${i}${extra};`;
const agents = ["a", "b", "c", "d", "e"];
const rounds = 40;

const files: Record<string, string> = {};
for (let f = 0; f < fileCount; f++) {
	files[`src/f${f}.ts`] = `${Array.from({ length: linesPer }, (_, i) => lineOf(f, i)).join("\n")}\n`;
}

const store = new MemoryStore();
const project = new Project(store);
let t = performance.now();
project.init(files, 0);
const initMs = performance.now() - t;
for (const a of agents) project.sync(a);

const times: Record<string, number[]> = { edit: [], publish: [], sync: [], record: [] };
const time = (name: string, fn: () => void): void => {
	const t0 = performance.now();
	fn();
	times[name]!.push(performance.now() - t0);
};

let n = 0;
let outOfStep = 0;
for (let r = 0; r < rounds; r++) {
	for (const [i, a] of agents.entries()) {
		const f = (r * agents.length + i) % fileCount;
		const line = (r * 7) % linesPer;
		n++;
		time("edit", () => {
			const answer = project.edit(
				a,
				{ file: `src/f${f}.ts`, old: lineOf(f, line), new: lineOf(f, line, ` + ${n}`) },
				n,
			);
			if (!answer.ok) outOfStep++;
		});
	}
	for (const a of agents) time("publish", () => project.publish(a, `round ${r}`, n));
	for (const a of agents) time("sync", () => project.sync(a));
}

const stats = (xs: number[]): string => {
	const s = [...xs].sort((p, q) => p - q);
	return `median ${s[Math.floor(s.length / 2)]!.toFixed(1)} ms, p90 ${s[Math.floor(s.length * 0.9)]!.toFixed(1)} ms, max ${s[s.length - 1]!.toFixed(1)} ms (${s.length})`;
};

t = performance.now();
const again = Project.load(store.entries as Entry[], new MemoryStore());
const loadMs = performance.now() - t;
again.status();

console.log(
	`${fileCount} files x ${linesPer} lines = ${fileCount * linesPer} lines (${kind}), ${agents.length} agents, ${rounds} rounds`,
);
console.log(`edits out of step: ${outOfStep}`);
console.log(
	`init ${initMs.toFixed(0)} ms; reload of ${store.entries.length} entries ${loadMs.toFixed(0)} ms; log ${(JSON.stringify(store.entries).length / 1e6).toFixed(1)} MB`,
);
for (const [name, xs] of Object.entries(times)) if (xs.length) console.log(`${name}: ${stats(xs)}`);
