// The git view: one commit per atom (or per label), trees equal to the
// engine's projections, trailers git itself can read, and identical hashes
// for the same set and options.

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { type AtomId, history, labelContents, project } from "../../engine/index.ts";
import { lines, Repo, Rng } from "../../engine/test/helpers.ts";
import { GitViewError, gitEmail, headsOf, planView, type ViewResult, writeView } from "../index.ts";
import { cleanup, commitFiles, freshPath, git, sorted, tempDir, workingFiles } from "./helpers.ts";

after(cleanup);

/** A small graph with parallel atoms, a file made from nothing, reasons, resolves and two labels. */
function sample(): Repo {
	const repo = Repo.init({
		"src/app.ts": lines("const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "export { a, b, c, d };"),
		"README.md": lines("# App", "", "Says hello."),
	});
	const b = repo.edit({
		author: "ann",
		message: "b is two hundred",
		edits: [{ file: "src/app.ts", old: "const b = 2;", new: "const b = 200;" }],
	});
	const util = repo.edit({
		author: "bob",
		message: "add a util file",
		edits: [{ file: "src/util.ts", old: "", new: lines("export const twice = (x: number) => 2 * x;") }],
	});
	const readme = repo.edit({
		author: "ann",
		message: "document the new b",
		edits: [{ file: "README.md", old: "Says hello.\n", new: "Says hello.\nb is 200 now.\n" }],
		needs: [b.id],
		reasons: [{ to: b.id, kind: "together", text: "the readme quotes b\nso they move together" }],
	});
	// Two inserts into the same gap, written against the same view: a conflict, then a resolution.
	const before = new Set(repo.shared);
	const x = repo.edit(
		{ author: "cy", message: "x after d", edits: [{ file: "src/app.ts", start: 4, end: 4, lines: ["const x = 0;"] }] },
		before,
	);
	const y = repo.edit(
		{ author: "dee", message: "y after d", edits: [{ file: "src/app.ts", start: 4, end: 4, lines: ["const y = 0;"] }] },
		before,
	);
	const xy = repo
		.view()
		.lines("src/app.ts")
		.findIndex((l) => l.text === "const x = 0;" || l.text === "const y = 0;");
	repo.edit({
		author: "eve",
		message: "keep both, x first",
		edits: [{ file: "src/app.ts", start: xy, end: xy + 2, lines: ["const x = 0;", "const y = 0;"] }],
		resolves: [x.id, y.id],
	});
	repo.graph.setLabel({ name: "b-change", head: readme.id, title: "Change b", message: "b and its docs" });
	repo.graph.setLabel({ name: "util", head: util.id, title: "Util", message: "" });
	return repo;
}

/** Trailers as git itself parses them: one map per commit, oldest first. */
function gitTrailers(dir: string): Map<string, string[]>[] {
	const out = git(dir, ["log", "--reverse", "--format=%H%x00%(trailers:only,unfold)%x01"]);
	return out
		.split("\x01")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((s) => {
			const [, block] = s.split("\x00");
			const map = new Map<string, string[]>();
			for (const line of (block ?? "").split("\n")) {
				const m = /^([^:]+): (.*)$/.exec(line.trim());
				if (m) map.set(m[1]!, [...(map.get(m[1]!) ?? []), m[2]!]);
			}
			return map;
		});
}

describe("per-atom view", () => {
	const repo = sample();
	const graph = repo.graph;
	const order = history(graph, repo.shared).map((a) => a.id);
	let result: ViewResult;
	const dir = freshPath("view");

	it("writes one commit per atom, in history order, a0 first as the root", async () => {
		result = await writeView(graph, repo.shared, dir);
		assert.equal(result.commits.length, repo.shared.size);
		assert.deepEqual(
			result.commits.map((c) => c.atoms),
			order.map((id) => [id]),
		);
		assert.equal(order[0], "a0");
		const log = git(dir, ["log", "--reverse", "--format=%H %P"]).trim().split("\n");
		assert.equal(log.length, order.length);
		assert.equal(log[0]!.trim(), result.commits[0]!.oid, "the root commit has no parent");
		log.forEach((line, i) => {
			const [oid, parent] = line.split(" ");
			assert.equal(oid, result.commits[i]!.oid);
			if (i > 0) assert.equal(parent, result.commits[i - 1]!.oid);
		});
		assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), result.head);
		assert.equal(git(dir, ["symbolic-ref", "HEAD"]).trim(), "refs/heads/main");
		git(dir, ["fsck", "--strict"]);
	});

	it("gives each commit the projection of its prefix of history", async () => {
		for (let i = 0; i < order.length; i++) {
			const expected = sorted(project(graph, order.slice(0, i + 1)));
			assert.deepEqual(await commitFiles(dir, result.commits[i]!.oid), expected, `commit ${i} (${order[i]})`);
		}
	});

	it("checks the tip out, clean as far as git can tell", () => {
		assert.deepEqual(workingFiles(dir), sorted(project(graph, repo.shared)));
		assert.equal(git(dir, ["status", "--porcelain"]), "");
	});

	it("writes Atom, Deps, Resolves, Reason and View-Heads trailers that git reads", () => {
		const trailers = gitTrailers(dir);
		assert.equal(trailers.length, order.length);
		order.forEach((id, i) => {
			const t = trailers[i]!;
			const atom = graph.atom(id);
			assert.deepEqual(t.get("Atom"), [id]);
			assert.deepEqual(t.get("Deps"), atom.deps.length > 0 ? [atom.deps.join(" ")] : undefined);
			assert.deepEqual(t.get("Resolves"), atom.resolves.length > 0 ? [atom.resolves.join(" ")] : undefined);
			assert.deepEqual(t.get("View-Heads"), [headsOf(graph, new Set(order.slice(0, i + 1))).join(" ")]);
			assert.deepEqual(
				t.get("Reason"),
				atom.reasons.length > 0
					? atom.reasons.map((r) => `${id} ${r.kind} ${r.to}: ${r.text.replace(/\s*\n\s*/g, " ")}`)
					: undefined,
			);
		});
		// The reason's line break became a space; the parallel atoms show as several heads.
		const readme = graph.atoms().find((a) => a.message === "document the new b")!;
		assert.ok(
			trailers[order.indexOf(readme.id)]!.get("Reason")![0]!.endsWith("the readme quotes b so they move together"),
		);
		assert.ok(trailers.some((t) => t.get("View-Heads")![0]!.split(" ").length >= 3));
	});

	it("uses the atom's author, a derived email, and the atom's time", () => {
		const log = git(dir, ["log", "--reverse", "--format=%an|%ae|%at|%cn|%ct|%s"]).trim().split("\n");
		order.forEach((id, i) => {
			const atom = graph.atom(id);
			const [an, ae, at, cn, ct, subject] = log[i]!.split("|");
			assert.equal(an, atom.author);
			assert.equal(cn, atom.author);
			assert.equal(ae, gitEmail(atom.author));
			assert.equal(Number(at), Math.floor(atom.time / 1000));
			assert.equal(Number(ct), Math.floor(atom.time / 1000));
			assert.equal(subject, atom.message.split("\n")[0]);
		});
		assert.equal(gitEmail("Ann Lee"), "ann-lee@atoms.invalid");
		assert.equal(gitEmail("<>"), "unknown@atoms.invalid");
	});
});

describe("determinism", () => {
	const repo = sample();
	const graph = repo.graph;
	const tip = history(graph, repo.shared).at(-1)!.id;

	it("gives identical hashes across runs and across input orders", async () => {
		const rng = new Rng(7);
		const inputs: Iterable<AtomId>[] = [
			repo.shared,
			[...repo.shared].reverse(),
			new Set(rng.shuffle([...repo.shared])),
			rng.shuffle([...repo.shared]),
		];
		const runs: string[][] = [];
		for (const input of inputs) runs.push((await writeView(graph, input, freshPath("view"))).commits.map((c) => c.oid));
		for (const run of runs.slice(1)) assert.deepEqual(run, runs[0]);
	});

	it("gives the same hashes for a ref and its closure given as a set", async () => {
		const closure = graph.closure(tip);
		const byRef = await writeView(graph, tip, freshPath("view"));
		const bySet = await writeView(graph, new Rng(3).shuffle([...closure]), freshPath("view"));
		assert.deepEqual(
			byRef.commits.map((c) => c.oid),
			bySet.commits.map((c) => c.oid),
		);
		assert.deepEqual(
			byRef.set,
			[...closure].sort((a, b) => graph.atom(a).seq - graph.atom(b).seq),
		);
	});

	it("gives identical hashes by label too, and in the plan whatever the input order", async () => {
		const one = await writeView(graph, repo.shared, freshPath("view"), { byLabel: true });
		const two = await writeView(graph, [...repo.shared].reverse(), freshPath("view"), { byLabel: true });
		assert.deepEqual(
			one.commits.map((c) => c.oid),
			two.commits.map((c) => c.oid),
		);
		assert.deepEqual(planView(graph, repo.shared), planView(graph, new Rng(9).shuffle([...repo.shared])));
	});

	it("gives different hashes for a different set", async () => {
		const a = await writeView(graph, repo.shared, freshPath("view"));
		const b = await writeView(graph, tip, freshPath("view"));
		assert.notEqual(a.head, b.head);
	});
});

describe("by-label view", () => {
	const repo = sample();
	const graph = repo.graph;
	let result: ViewResult;
	const dir = freshPath("view");

	it("writes a0, then one commit per label in dependency order, then the rest", async () => {
		result = await writeView(graph, repo.shared, dir, { byLabel: true });
		const [root, ...rest] = result.commits;
		assert.deepEqual(root!.atoms, ["a0"]);
		// Labels by their heads' priority: util's head made a file from nothing
		// (lamport 0), b-change's head sits two atoms up.
		assert.deepEqual(
			rest.map((c) => c.label),
			["util", "b-change", undefined],
		);
		// Each label commit adds exactly the label's contents not already covered.
		const bChange = rest.find((c) => c.label === "b-change")!;
		assert.deepEqual(bChange.atoms, labelContents(graph, graph.label("b-change")!));
		const util = rest.find((c) => c.label === "util")!;
		assert.deepEqual(util.atoms, labelContents(graph, graph.label("util")!));
		// The last commit holds everything no label covered.
		const leftover = rest.at(-1)!;
		assert.equal(leftover.label, undefined);
		const covered = new Set(result.commits.slice(0, -1).flatMap((c) => c.atoms));
		assert.deepEqual(new Set(leftover.atoms), new Set([...repo.shared].filter((id) => !covered.has(id))));
		assert.equal(result.commits.flatMap((c) => c.atoms).length, repo.shared.size);
	});

	it("orders a label after the labels its atoms depend on", () => {
		const graph2 = sample().graph;
		// A label whose head depends on b-change's head must come after it.
		const readme = graph2.label("b-change")!.head;
		graph2.setLabel({ name: "aaa-first-by-name", head: readme, title: "same head", message: "" });
		const b = graph2.atoms().find((a) => a.message === "b is two hundred")!.id;
		graph2.setLabel({ name: "zzz-b-only", head: b, title: "b only", message: "" });
		const plan = planView(graph2, graph2.closure(readme), { byLabel: true });
		const names = plan.commits.map((c) => c.label);
		assert.ok(names.indexOf("zzz-b-only") < names.indexOf("b-change"));
		assert.ok(names.indexOf("zzz-b-only") < names.indexOf("aaa-first-by-name"));
		// Same head: both get a commit; the second adds nothing.
		const same = plan.commits.filter((c) => c.label === "b-change" || c.label === "aaa-first-by-name");
		assert.equal(same.length, 2);
		assert.deepEqual(same[1]!.atoms, []);
	});

	it("gives each commit the projection of everything up to it", async () => {
		const plan = planView(graph, repo.shared, { byLabel: true });
		for (let i = 0; i < result.commits.length; i++) {
			const expected = sorted(project(graph, plan.order.slice(0, plan.commits[i]!.count)));
			assert.deepEqual(await commitFiles(dir, result.commits[i]!.oid), expected);
		}
		assert.deepEqual(workingFiles(dir), sorted(project(graph, repo.shared)));
	});

	it("writes the label title and message, and Label, Atoms and View-Heads trailers", () => {
		const trailers = gitTrailers(dir);
		const bIndex = result.commits.findIndex((c) => c.label === "b-change");
		assert.deepEqual(trailers[bIndex]!.get("Label"), ["b-change"]);
		assert.deepEqual(trailers[bIndex]!.get("Atoms"), [result.commits[bIndex]!.atoms.join(" ")]);
		assert.ok(trailers[bIndex]!.get("Reason")![0]!.includes("together"));
		assert.ok(trailers.every((t) => (t.get("View-Heads") ?? []).length === 1));
		const body = git(dir, ["show", "-s", "--format=%B", result.commits[bIndex]!.oid]);
		assert.ok(body.startsWith("Change b\n\nb and its docs\n\nLabel: b-change\n"));
		const subjects = git(dir, ["log", "--reverse", "--format=%s"]).trim().split("\n");
		assert.equal(subjects.at(-1), "Atoms outside any label");
	});
});

describe("view errors", () => {
	const repo = sample();
	it("refuses a set that is not closed", async () => {
		const readme = repo.graph.atoms().find((a) => a.message === "document the new b")!;
		await assert.rejects(writeView(repo.graph, ["a0", readme.id], freshPath("view")), (err: unknown) => {
			assert.ok(err instanceof GitViewError);
			assert.equal(err.code, "not-closed");
			return true;
		});
	});

	it("refuses an empty set and a directory with files in it", async () => {
		await assert.rejects(writeView(repo.graph, [], freshPath("view")), { code: "empty-set" });
		const dir = tempDir();
		fs.writeFileSync(`${dir}/keep.txt`, "x\n");
		await assert.rejects(writeView(repo.graph, "a0", dir), { code: "dir-not-empty" });
	});

	it("refuses paths git cannot hold", async () => {
		const bad = Repo.init({ "a/../b.txt": "x\n" });
		await assert.rejects(writeView(bad.graph, "a0", freshPath("view")), { code: "bad-path" });
		const clash = Repo.init({ a: "x\n", "a/b": "y\n" });
		await assert.rejects(writeView(clash.graph, "a0", freshPath("view")), { code: "bad-path" });
	});

	it("passes unknown refs through as engine errors", async () => {
		await assert.rejects(writeView(repo.graph, "no-such-label", freshPath("view")), { code: "unknown-ref" });
	});
});
