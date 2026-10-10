// Property: random git commits on top of a random view ingest exactly. For
// every commit, the state its label names projects to the commit's tree; the
// hunks of one commit are independent atoms; with no live work the shared
// projection equals the last commit; live atoms only ever conflict with
// ingested hunks; and ingesting again adds nothing.
//   PROP_SEED=<seed> PROP_CASES=1 node --test src/gitview/test/random.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { writeCommit, writeRef } from "isomorphic-git";
import { type AtomId, diffLines, independent, project, splitLines, stateOf } from "../../engine/index.ts";
import { Repo, Rng } from "../../engine/test/helpers.ts";
import { gitContext, ingest, writeCache, writeFilesTree, writeView } from "../index.ts";
import { cleanup, commitFiles, freshPath, sorted } from "./helpers.ts";

after(cleanup);

const BASE_SEED = Number(process.env.PROP_SEED ?? 20261003);
const CASES = Number(process.env.PROP_CASES ?? 30);

// A small vocabulary, so files repeat lines and diffs have choices to make.
const WORDS = ["{", "}", "x", "y", "return x;", "", "let a = 1;", "let b = 2;"];

type Files = Record<string, string>;

function randomLines(rng: Rng, min: number, max: number, tag: string): string[] {
	return Array.from({ length: rng.range(min, max) }, (_, i) => (rng.chance(0.5) ? rng.pick(WORDS) : `${tag} ${i}`));
}

const text = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join("");

/** One person's commit: a few random line edits, sometimes a new or deleted file. */
function randomCommit(rng: Rng, files: Files, n: number): Files {
	const out: Files = { ...files };
	const ops = rng.range(1, 4);
	for (let k = 0; k < ops; k++) {
		const paths = Object.keys(out).sort();
		const roll = rng.next();
		if (paths.length === 0 || roll < 0.12) {
			out[`dir${rng.int(2)}/new${n}_${k}.txt`] = text(randomLines(rng, 1, 4, `c${n}`));
			continue;
		}
		const path = rng.pick(paths);
		if (roll < 0.18 && paths.length > 1) {
			delete out[path];
			continue;
		}
		const lines = splitLines(out[path]!);
		const start = rng.int(lines.length + 1);
		const end = Math.min(lines.length, start + rng.int(3));
		const fresh = randomLines(rng, start === end ? 1 : 0, 3, `c${n}.${k}`);
		lines.splice(start, end - start, ...fresh);
		if (lines.length === 0) delete out[path];
		else out[path] = text(lines);
	}
	return out;
}

/** Write a commit straight into the repo (no working tree), as plain git would. */
async function commitInto(
	dir: string,
	files: Files,
	parent: string,
	n: number,
	cache: ReturnType<typeof writeCache>,
): Promise<string> {
	const tree = await writeFilesTree(gitContext(dir), files, cache);
	const who = {
		name: n % 2 === 0 ? "Pat" : "Sam",
		email: "p@example.com",
		timestamp: 1_700_000_000 + 60 * n,
		timezoneOffset: 0,
	};
	const oid = await writeCommit({
		fs,
		dir,
		commit: { message: `commit ${n}\n`, tree, parent: [parent], author: who, committer: who },
	});
	await writeRef({ fs, dir, ref: "refs/heads/main", value: oid, force: true });
	return oid;
}

// The seeds share nothing (each has its own temp folder and cache), so 8 run at once: 81 s one by one, about 11 s so.
describe("random commits ingest exactly", { concurrency: 8 }, () => {
	for (let c = 0; c < CASES; c++) {
		const seed = BASE_SEED + c;
		it(`seed ${seed}`, async () => {
			const rng = new Rng(seed);
			const start: Files = {};
			for (let f = 0; f < rng.range(1, 3); f++) start[`f${f}.txt`] = text(randomLines(rng, 2, 8, `base${f}`));
			const repo = Repo.init(start);
			// A few atoms from agents first, so the view has history and parallel heads.
			for (let a = 0; a < rng.range(0, 3); a++) {
				const view = repo.view();
				const path = rng.pick(view.paths());
				const count = view.lines(path).length;
				const at = rng.int(count + 1);
				repo.edit({
					author: "agent",
					message: `agent ${a}`,
					edits: [{ file: path, start: at, end: Math.min(count, at + rng.int(2)), lines: [`agent ${a}`] }],
				});
			}

			const dir = freshPath("view");
			const view = await writeView(repo.graph, repo.shared, dir, { byLabel: rng.chance(0.3), checkout: false });
			const viewFiles = sorted(project(repo.graph, repo.shared));
			let files = viewFiles;
			let head = view.head;
			const cache = writeCache();
			const commits: { oid: string; files: Files }[] = [];
			for (let n = 0; n < rng.range(1, 4); n++) {
				files = sorted(randomCommit(rng, files, n));
				head = await commitInto(dir, files, head, n, cache);
				commits.push({ oid: head, files });
			}

			// Live work in the shared set the person never saw.
			const live = new Set<AtomId>();
			if (rng.chance(0.5)) {
				for (let l = 0; l < rng.range(1, 2); l++) {
					const v = repo.view();
					const path = rng.pick(v.paths());
					const at = rng.int(v.lines(path).length);
					live.add(
						repo.edit({
							author: "live",
							message: `live ${l}`,
							edits: [{ file: path, start: at, end: at + 1, lines: [`live ${l}`] }],
						}).id,
					);
				}
			}

			const result = await ingest(repo.graph, repo.shared, dir);
			assert.equal(result.commits.length, commits.length);
			let before = viewFiles;
			for (const [i, ingested] of result.commits.entries()) {
				const expected = commits[i]!;
				assert.equal(ingested.commit, expected.oid);
				// The label's state is the commit's tree.
				assert.deepEqual(sorted(project(repo.graph, stateOf(repo.graph, ingested.label))), expected.files);
				assert.deepEqual(await commitFiles(dir, expected.oid), expected.files);
				// One atom per diff hunk, all independent of each other.
				let hunks = 0;
				for (const path of new Set([...Object.keys(before), ...Object.keys(expected.files)])) {
					hunks += diffLines(splitLines(before[path] ?? ""), splitLines(expected.files[path] ?? "")).length;
				}
				assert.equal(ingested.hunks.length, hunks);
				for (const a of ingested.hunks)
					for (const b of ingested.hunks) if (a < b) assert.ok(independent(repo.graph, a, b));
				before = expected.files;
			}

			const ingestedHunks = new Set(result.commits.flatMap((c) => c.hunks));
			for (const conflict of result.conflicts) {
				const [a, b] = conflict.atoms;
				assert.ok((live.has(a) && ingestedHunks.has(b)) || (live.has(b) && ingestedHunks.has(a)), `${a} ${b}`);
			}
			if (live.size === 0) {
				assert.deepEqual(result.conflicts, []);
				assert.deepEqual(sorted(project(repo.graph, result.shared)), commits.at(-1)!.files);
			}

			const again = await ingest(repo.graph, result.shared, dir);
			assert.equal(again.atoms.length, 0);
			assert.equal(again.base.kind, "ingested");
		});
	}
});
