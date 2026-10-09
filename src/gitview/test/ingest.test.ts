// Plain git in: a person clones a view, commits with the git CLI, and the
// repo is ingested. One atom per hunk, a tie and a label per commit, the
// state after each commit equal to the commit's tree, and conflicts with
// live atoms reported with both sides.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type AtomId, Graph, independent, labelContents, project, stateOf } from "../../engine/index.ts";
import { lines, Repo } from "../../engine/test/helpers.ts";
import { GitViewError, type IngestResult, ingest, parseTrailers, writeView } from "../index.ts";
import { cleanup, commitFiles, freshPath, git, numbered, Person, sorted, workingFiles } from "./helpers.ts";

after(cleanup);

const APP = numbered("app line", 12);
const NOTES = lines("# Notes", "one", "two");

function start(): Repo {
	return Repo.init({ "app.txt": APP, "notes.md": NOTES });
}

async function viewAndClone(repo: Repo, who = "Pat"): Promise<{ viewDir: string; person: Person }> {
	const viewDir = freshPath("view");
	await writeView(repo.graph, repo.shared, viewDir);
	return { viewDir, person: Person.clone(who, viewDir) };
}

describe("ingest round trip", () => {
	const repo = start();
	let person: Person;
	const shas: string[] = [];
	let result: IngestResult;

	it("cuts each commit into one atom per hunk plus a tie, and labels each commit", async () => {
		({ person } = await viewAndClone(repo));
		person.setLine("app.txt", 3, "app line three");
		shas.push(person.commit("Spell out line three"));
		person.write("lib/new.txt", lines("new one", "new two", "new three"));
		shas.push(person.commit("Add a new file"));
		person.remove("notes.md");
		shas.push(person.commit("Drop the notes"));
		person.setLine("app.txt", 1, "APP LINE 1");
		person.setLine("app.txt", 6, "APP LINE 6");
		const text = person.read("app.txt").replace("app line 10\n", "app line 10\ninserted a\ninserted b\n");
		person.write("app.txt", text);
		shas.push(person.commit("Three changes at once\n\nTop, middle, and an insert near the end."));

		const before = new Set(repo.shared);
		result = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(result.base.kind, "view");
		assert.deepEqual(result.base.heads, ["a0"]);
		assert.equal(result.base.atom, "a0");
		assert.deepEqual(
			result.commits.map((c) => c.commit),
			shas,
		);
		assert.deepEqual(
			result.commits.map((c) => c.hunks.length),
			[1, 1, 1, 3],
		);
		assert.deepEqual(
			result.labels.map((l) => l.name),
			shas.map((s) => `git-${s.slice(0, 7)}`),
		);
		assert.equal(result.atoms.length, 6 + 4);
		assert.deepEqual(result.conflicts, []);
		assert.deepEqual(result.revived, []);
		assert.deepEqual(result.skipped, []);
		// The shared set passed in is untouched; the graph has the new atoms and labels.
		assert.deepEqual(repo.shared, before);
		for (const atom of result.atoms) assert.equal(repo.graph.atom(atom.id), atom);
		for (const label of result.labels) assert.deepEqual(repo.graph.label(label.name), label);
		repo.shared = result.shared;
	});

	it("makes the shared projection equal the working tree", () => {
		assert.deepEqual(sorted(project(repo.graph, repo.shared)), workingFiles(person.dir));
	});

	it("gives every label exactly its commit: hunks plus tie, and state equal to the commit tree", async () => {
		for (const [i, c] of result.commits.entries()) {
			const label = repo.graph.label(c.label)!;
			assert.equal(label.head, c.tie);
			assert.deepEqual(labelContents(repo.graph, label), [...c.hunks, c.tie]);
			assert.equal(label.base, i === 0 ? "a0" : result.commits[i - 1]!.label);
			assert.deepEqual(label.follows, i === 0 ? undefined : [result.commits[i - 1]!.label]);
			assert.deepEqual(
				sorted(project(repo.graph, stateOf(repo.graph, c.label))),
				await commitFiles(person.dir, c.commit),
			);
		}
		assert.equal(repo.graph.label(result.commits[3]!.label)!.title, "Three changes at once");
		assert.equal(repo.graph.label(result.commits[3]!.label)!.message, "Top, middle, and an insert near the end.");
	});

	it("writes hunks as parallel atoms with the git author, time and message", () => {
		const last = result.commits[3]!;
		const [h1, h2, h3] = last.hunks as [AtomId, AtomId, AtomId];
		assert.ok(independent(repo.graph, h1, h2) && independent(repo.graph, h2, h3) && independent(repo.graph, h1, h3));
		// None of them needed the earlier commits' hunks: they touched other lines.
		for (const h of last.hunks)
			for (const earlier of result.commits[0]!.hunks) assert.ok(!repo.graph.dependsOn(h, earlier));
		for (const id of last.hunks) {
			const atom = repo.graph.atom(id);
			assert.equal(atom.author, "Pat");
			assert.equal(atom.time, person.lastTime());
			assert.ok(
				atom.message.startsWith(
					"Three changes at once\n\nTop, middle, and an insert near the end.\n\nHunk: app.txt @@",
				),
			);
		}
		assert.deepEqual(
			last.hunks.map((id) => parseTrailers(repo.graph.atom(id).message).find((t) => t.key === "Hunk")!.value),
			["app.txt @@ -1,1 +1,1 @@", "app.txt @@ -6,1 +6,1 @@", "app.txt @@ -10,0 +11,2 @@"],
		);
		// Default claims: the insertion reads both neighbours and writes the gap.
		const insert = repo.graph.atom(h3);
		assert.deepEqual(insert.reads, ["L:a0.10", "L:a0.9"]);
		assert.deepEqual(insert.writes, ["G:a0.9"]);
		// The file deletion is one atom deleting every line.
		const drop = repo.graph.atom(result.commits[2]!.hunks[0]!);
		assert.equal(drop.deletes.length, 3);
		assert.equal(drop.inserts.length, 0);
	});

	it("ties each commit to its hunks and the state before it", () => {
		result.commits.forEach((c, i) => {
			const tie = repo.graph.atom(c.tie);
			assert.deepEqual(tie.inserts, []);
			assert.deepEqual(tie.deletes, []);
			assert.deepEqual(new Set(tie.needs), new Set([...c.hunks, i === 0 ? "a0" : result.commits[i - 1]!.tie]));
			assert.ok(tie.message.startsWith(git(person.dir, ["show", "-s", "--format=%B", c.commit]).trim()));
			assert.deepEqual(parseTrailers(tie.message).find((t) => t.key === "Git-Commit")?.value, c.commit);
		});
	});

	it("resumes where the last ingest stopped, and ingests nothing twice", async () => {
		const again = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(again.base.kind, "ingested");
		assert.equal(again.base.commit, shas[3]);
		assert.equal(again.atoms.length, 0);
		assert.deepEqual(again.shared, repo.shared);

		person.setLine("app.txt", 12, "app line twelve");
		const sha = person.commit("One more");
		const size = repo.graph.size;
		const more = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(more.base.kind, "ingested");
		assert.equal(more.base.atom, result.commits[3]!.tie);
		assert.equal(more.base.label, result.commits[3]!.label);
		assert.deepEqual(
			more.commits.map((c) => c.commit),
			[sha],
		);
		assert.equal(repo.graph.size, size + 2);
		const label = repo.graph.label(more.commits[0]!.label)!;
		assert.equal(label.base, result.commits[3]!.label);
		assert.deepEqual(labelContents(repo.graph, label), [...more.commits[0]!.hunks, more.commits[0]!.tie]);
		repo.shared = more.shared;
		assert.deepEqual(sorted(project(repo.graph, repo.shared)), workingFiles(person.dir));
	});

	it("takes a fresh view of the ingested work back in, and by-label views rebuild the git history", async () => {
		// Per-atom view of the new shared set; a second person continues from it.
		const viewDir = freshPath("view");
		await writeView(repo.graph, repo.shared, viewDir);
		const sam = Person.clone("Sam", viewDir);
		sam.setLine("lib/new.txt", 2, "new TWO");
		sam.commit("Shout two");
		const res = await ingest(repo.graph, repo.shared, sam.dir);
		assert.equal(res.base.kind, "view");
		assert.equal(res.commits.length, 1);
		repo.shared = res.shared;
		assert.deepEqual(sorted(project(repo.graph, repo.shared)), workingFiles(sam.dir));

		// One commit per label: a0, then Pat's commits, then Sam's, each tree equal to the git commit's.
		const byLabel = freshPath("view");
		const written = await writeView(repo.graph, repo.shared, byLabel, { byLabel: true });
		const patCommits = [...shas, git(person.dir, ["rev-parse", "HEAD"]).trim()];
		const expected = [...patCommits.map((s) => ({ dir: person.dir, sha: s })), { dir: sam.dir, sha: sam.head() }];
		assert.deepEqual(written.commits.length, 1 + expected.length);
		for (const [i, e] of expected.entries()) {
			assert.deepEqual(await commitFiles(byLabel, written.commits[i + 1]!.oid), await commitFiles(e.dir, e.sha));
		}
		const subjects = git(byLabel, ["log", "--reverse", "--format=%s"]).trim().split("\n");
		assert.deepEqual(subjects.slice(1), [
			"Spell out line three",
			"Add a new file",
			"Drop the notes",
			"Three changes at once",
			"One more",
			"Shout two",
		]);
	});
});

describe("ingest against live work", () => {
	it("reports a conflict with both sides when a live atom changed the same line", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo, "Pat");
		// Meanwhile, in the shared workspace:
		const live = repo.edit({
			author: "live-agent",
			message: "line 5 becomes five",
			edits: [{ file: "app.txt", old: "app line 5\n", new: "app line five\n" }],
		});
		person.setLine("app.txt", 5, "app line FIVE");
		person.commit("Pat shouts line five");

		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(result.conflicts.length, 1);
		const [c] = result.conflicts;
		const hunk = result.commits[0]!.hunks[0]!;
		assert.deepEqual(c!.atoms, [live.id, hunk]);
		assert.equal(c!.kind, "edit-edit");
		assert.deepEqual(c!.sides, [
			{ atom: live.id, author: "live-agent", message: "line 5 becomes five" },
			{ atom: hunk, author: "Pat", message: "Pat shouts line five\n\nHunk: app.txt @@ -5,1 +5,1 @@" },
		]);
		assert.deepEqual(
			c!.keys.map((k) => k.key),
			["L:a0.4"],
		);
		assert.deepEqual(c!.resolvedBy, []);
		// Accepted anyway: both atoms are in the shared set.
		assert.ok(result.shared.has(live.id) && result.shared.has(hunk));
	});

	it("reports no conflict when the commit only touches lines nobody else touched", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo, "Pat");
		repo.edit({
			author: "live-agent",
			message: "line 2",
			edits: [{ file: "app.txt", old: "app line 2\n", new: "app line two\n" }],
		});
		repo.edit({
			author: "live-agent",
			message: "notes",
			edits: [{ file: "notes.md", old: "two\n", new: "two\nthree\n" }],
		});
		person.setLine("app.txt", 9, "app line nine");
		person.write("app.txt", person.read("app.txt") + "app line 13\n");
		person.commit("Pat edits the bottom");

		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.deepEqual(result.conflicts, []);
		assert.equal(result.commits[0]!.hunks.length, 2);
		// Both sides' changes are in the projection.
		const expected = person.read("app.txt").replace("app line 2\n", "app line two\n");
		assert.equal(project(repo.graph, result.shared)["app.txt"], expected);
		assert.equal(project(repo.graph, result.shared)["notes.md"], lines("# Notes", "one", "two", "three"));
	});

	it("puts base atoms the shared set dropped back, and says so", async () => {
		const repo = start();
		const extra = repo.edit({
			author: "ann",
			message: "append",
			edits: [{ file: "notes.md", old: "two\n", new: "two\nthree\n" }],
		});
		const { person } = await viewAndClone(repo, "Pat");
		repo.shared.delete(extra.id); // dropped from the workspace after the view was written
		person.setLine("notes.md", 4, "THREE");
		person.commit("Pat edits the appended line");
		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.deepEqual(result.revived, [extra.id]);
		assert.ok(result.shared.has(extra.id));
	});
});

describe("ingest edge cases", () => {
	it("ties a view with several heads with one anchor atom, reused by the next ingest", async () => {
		const repo = start();
		const x = repo.edit({ author: "ann", message: "x file", edits: [{ file: "x.txt", old: "", new: "x\n" }] });
		const y = repo.edit({ author: "bob", message: "y file", edits: [{ file: "y.txt", old: "", new: "y\n" }] });
		const viewDir = freshPath("view");
		await writeView(repo.graph, repo.shared, viewDir);
		const pat = Person.clone("Pat", viewDir);
		pat.setLine("app.txt", 1, "first");
		pat.commit("Pat edits line 1");
		const one = await ingest(repo.graph, repo.shared, pat.dir);
		assert.deepEqual(one.base.heads, ["a0", x.id, y.id]);
		const anchor = one.base.anchor!;
		assert.equal(one.base.atom, anchor);
		assert.deepEqual(repo.graph.atom(anchor).needs, ["a0", x.id, y.id]);
		assert.equal(repo.graph.label(one.commits[0]!.label)!.base, anchor);
		assert.deepEqual(labelContents(repo.graph, repo.graph.label(one.commits[0]!.label)!), [
			...one.commits[0]!.hunks,
			one.commits[0]!.tie,
		]);
		repo.shared = one.shared;

		const sam = Person.clone("Sam", viewDir);
		sam.setLine("app.txt", 12, "last");
		sam.commit("Sam edits line 12");
		const two = await ingest(repo.graph, repo.shared, sam.dir);
		assert.equal(two.base.anchor, anchor);
		assert.equal(two.atoms.length, 2, "one hunk and one tie, no new anchor");
		repo.shared = two.shared;
		assert.deepEqual(two.conflicts, []);
		assert.equal(
			project(repo.graph, repo.shared)["app.txt"],
			APP.replace("app line 1\n", "first\n").replace("app line 12\n", "last\n"),
		);
	});

	it("skips empty and binary files, listing each when it appears or changes", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo);
		person.write("pkg/__init__.py", "");
		person.write("logo.bin", new Uint8Array([0x89, 0x50, 0x00, 0x01]));
		const first = person.commit("Add a package marker and a logo");
		person.setLine("app.txt", 2, "two");
		person.commit("Edit line 2");
		person.write("logo.bin", new Uint8Array([0x89, 0x50, 0x00, 0x02]));
		person.write("notes.md", "");
		const third = person.commit("New logo, empty notes");

		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.deepEqual(result.skipped, [
			{ commit: first, path: "logo.bin", reason: "binary" },
			{ commit: first, path: "pkg/__init__.py", reason: "empty" },
			{ commit: third, path: "logo.bin", reason: "binary" },
			{ commit: third, path: "notes.md", reason: "empty" },
		]);
		assert.deepEqual(
			result.commits.map((c) => c.hunks.length),
			[0, 1, 1],
		);
		// Emptying a file deletes its lines; the projection has no such file.
		const files = project(repo.graph, result.shared);
		assert.deepEqual(Object.keys(files), ["app.txt"]);
		assert.deepEqual(sorted(files), workingFiles(person.dir));
	});

	it("ingests an amended view commit as the person's own change on its heads, without the view trailers", async () => {
		const repo = start();
		const uno = repo.edit({
			author: "ann",
			message: "touch notes",
			edits: [{ file: "notes.md", old: "one\n", new: "uno\n" }],
		});
		const { person } = await viewAndClone(repo);
		person.setLine("app.txt", 4, "four");
		const sha = person.amend();
		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(result.base.commit, sha);
		assert.deepEqual(result.base.heads, [uno.id]);
		assert.deepEqual(
			result.commits.map((c) => c.commit),
			[sha],
		);
		assert.deepEqual(
			result.commits.map((c) => c.hunks.length),
			[1],
			"only the amended-in line, not ann's",
		);
		assert.deepEqual(result.conflicts, []);
		const label = repo.graph.label(result.commits[0]!.label)!;
		assert.equal(label.title, "touch notes");
		assert.equal(label.message, "");
		assert.equal(label.base, uno.id);
		assert.ok(!repo.graph.atom(result.commits[0]!.tie).message.includes("View-Heads"));
		assert.deepEqual(sorted(project(repo.graph, result.shared)), workingFiles(person.dir));
	});

	it("does not take an amended root view commit as a base", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo);
		person.setLine("app.txt", 4, "four");
		person.amend(); // the view's only commit: nothing exact below it vouches for its trailer
		await assert.rejects(ingest(repo.graph, repo.shared, person.dir), { code: "no-view-base" });
	});

	it("reads CRLF files as their lines", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo);
		person.write("notes.md", "# Notes\r\none\r\nTWO\r\n");
		person.commit("CRLF and a change");
		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.equal(result.commits[0]!.hunks.length, 1);
		assert.equal(project(repo.graph, result.shared)["notes.md"], lines("# Notes", "one", "TWO"));
	});

	it("follows the first parent through a merge", async () => {
		const repo = start();
		const { person } = await viewAndClone(repo);
		git(person.dir, ["checkout", "--quiet", "-b", "side"]);
		person.setLine("app.txt", 11, "from the side");
		person.commit("Side change");
		git(person.dir, ["checkout", "--quiet", "main"]);
		person.setLine("app.txt", 2, "from main");
		person.commit("Main change");
		git(person.dir, ["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"], {
			GIT_AUTHOR_NAME: "Pat",
			GIT_AUTHOR_EMAIL: "pat@example.com",
			GIT_COMMITTER_NAME: "Pat",
			GIT_COMMITTER_EMAIL: "pat@example.com",
		});
		const result = await ingest(repo.graph, repo.shared, person.dir);
		assert.deepEqual(
			result.commits.map((c) => c.hunks.length),
			[1, 1],
		);
		assert.equal(repo.graph.label(result.commits[1]!.label)!.title, "Merge side");
		assert.deepEqual(sorted(project(repo.graph, result.shared)), workingFiles(person.dir));
	});

	it("refuses a repo that is not a view of this graph, and leaves the graph alone", async () => {
		const repo = start();
		const dir = freshPath("plain");
		git(process.cwd(), ["init", "--quiet", "-b", "main", dir]);
		const person = new Person("Pat", dir);
		person.write("a.txt", "a\n");
		person.commit("A plain repo");
		const size = repo.graph.size;
		await assert.rejects(ingest(repo.graph, repo.shared, dir), (err: unknown) => {
			assert.ok(err instanceof GitViewError);
			assert.equal(err.code, "no-view-base");
			return true;
		});
		await assert.rejects(ingest(repo.graph, repo.shared, freshPath("missing")), { code: "bad-repo" });
		// A view of another graph with different lines doesn't count either.
		const other = Repo.init({ "app.txt": "other\n" });
		const viewDir = freshPath("view");
		await writeView(other.graph, other.shared, viewDir);
		await assert.rejects(ingest(repo.graph, repo.shared, viewDir), { code: "no-view-base" });
		assert.equal(repo.graph.size, size);
		assert.ok(Graph.fromJSON(repo.graph.toJSON()));
	});
});
