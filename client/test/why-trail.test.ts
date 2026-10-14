// abso why past formatting to the reason (abso-core issue 20), and lines
// imported from git naming their commit and their tracker (issue 21), from
// the command line: a line imported from git, then reformatted.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gitOrigin, issueLinks, issueNumbers, issuesOf } from "../src/git-origin.ts";
import { main } from "../src/main.ts";
import { type Fake, startFake } from "./fake-server.ts";

const TOKEN = "test-token-not-secret";
const ENV = { AVCS_TOKEN: TOKEN, AVCS_HOOK_FORCE: "1", AVCS_SERVERS_FILE: "no-servers.json" };
const IMPORTED =
	"Merge queue: check publishes in batches (#39)\n\nCap the batch at 8.\n\ngit 4e1a7c2b9f03, Ada Lovelace, 2026-10-06T20:36:43-05:00";

let fake: Fake;
const dirs: string[] = [];
before(async () => {
	fake = await startFake(0, TOKEN);
});
after(async () => {
	await fake.close();
	for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function run(cwd: string, ...argv: string[]): Promise<{ exit: number; out: string }> {
	const r = await main(argv, { cwd, env: ENV, write: () => {} });
	return { exit: r.exit, out: r.stdout + r.stderr };
}

let projects = 0;
/** v0 init; v1 a git import changes the cap line; v2 a reformat. */
async function history(config = '{ "check": "true" }\n', message = IMPORTED): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "abso-why-"));
	dirs.push(dir);
	writeFileSync(join(dir, "abso.json"), config);
	writeFileSync(join(dir, "queue.ts"), "export function take(w) {\n\tconst n = Math.min(4, w);\n\treturn n;\n}\n");
	const made = await run(
		dir,
		"init",
		"--server",
		fake.url,
		"--project",
		`why${++projects}`,
		"--agent",
		"imp",
		"--as-is",
	);
	assert.equal(made.exit, 0, made.out);
	const edit = (from: string, to: string) =>
		writeFileSync(join(dir, "queue.ts"), readFileSync(join(dir, "queue.ts"), "utf8").replace(from, to));
	edit("Math.min(4, w); ", "Math.min(4, w);");
	edit("Math.min(4, w);", "Math.min(8, w); // #39");
	let r = await run(dir, "push", "-m", message);
	assert.equal(r.exit, 0, r.out);
	edit("\tconst n = Math.min(8, w); // #39", "  const n = Math.min(8, w) // #39");
	r = await run(dir, "push", "-m", "Format the code");
	assert.equal(r.exit, 0, r.out);
	return dir;
}

describe("abso why", () => {
	it("leads with the change that said what the line does, and says which formatting change it skipped", async () => {
		const dir = await history('{ "gitIssues": "https://github.com/owner/repo/issues/" }\n');
		const r = await run(dir, "why", "queue.ts:2");
		assert.equal(r.exit, 0, r.out);
		assert.match(r.out, /^queue\.ts line 2: {3}const n = Math\.min\(8, w\) \/\/ #39$/m);
		assert.match(r.out, /^Written by imp \(.*\), pushed in version 1 by imp \(.*\): "Merge queue: check publishes/m);
		assert.doesNotMatch(r.out, /pushed in version 1 [^\n]*git d9cf/, "the git line is said once, below");
		assert.match(r.out, /^ {2}From git: commit 4e1a7c2b9f03 by Ada Lovelace, 2026-10-06T20:36:43-05:00\.$/m);
		assert.match(r.out, /^ {2}#39 is https:\/\/github\.com\/owner\/repo\/issues\/39$/m);
		assert.match(r.out, /^Skipped 1 formatting change since: version 2 \(imp, "Format the code"\)\./m);
		assert.match(
			r.out,
			/^Earlier changes, newest first:\n {2}version 0 by init .*"Start the project"\n {4}It read: const n = Math\.min\(4, w\);$/m,
		);
	});

	it("--all leads with the newest change, formatting or not; --at reads an older version", async () => {
		const dir = await history();
		const all = await run(dir, "why", "queue.ts:2", "--all");
		assert.equal(all.exit, 0, all.out);
		assert.match(all.out, /^Written by imp .*pushed in version 2 .*"Format the code"/m);
		assert.match(
			all.out,
			/^ {2}version 1 by imp .*"Merge queue: check publishes in batches \(#39\)", from git commit 4e1a7c2b9f03 by Ada Lovelace$/m,
		);
		assert.doesNotMatch(all.out, /#39 is/, "no tracker: abso.json doesn't say where");
		const at = await run(dir, "why", "queue.ts:2", "--at", "0", "--json");
		assert.equal(at.exit, 0, at.out);
		assert.equal(JSON.parse(at.out).text, "\tconst n = Math.min(4, w);");
	});

	it("blame names an imported push's commit", async () => {
		const dir = await history();
		const r = await run(dir, "blame", "queue.ts", "--version", "1");
		assert.equal(r.exit, 0, r.out);
		assert.match(
			r.out,
			/^ {2}v1 by imp, .*: Merge queue: check publishes in batches \(#39\) \(from git commit 4e1a7c2b9f03 by Ada Lovelace\)$/m,
		);
	});
});

describe("git origins", () => {
	it("reads import-git's lines, a git push's, or the host's commit", () => {
		assert.deepEqual(gitOrigin({ message: `${IMPORTED}\nIssues: https://github.com/o/r/issues` }), {
			commit: "4e1a7c2b9f03",
			author: "Ada Lovelace",
			time: "2026-10-06T20:36:43-05:00",
			issues: "https://github.com/o/r/issues",
			message: "Merge queue: check publishes in batches (#39)\n\nCap the batch at 8.",
		});
		assert.deepEqual(gitOrigin({ message: "Fix\n\nGit-Commit: abcdef1234\nAuthor: Bo" }), {
			commit: "abcdef1234",
			author: "Bo",
			message: "Fix",
		});
		assert.deepEqual(gitOrigin({ message: "Plain", commit: "abc1234", author: "Cy" }, "https://x/issues"), {
			commit: "abc1234",
			author: "Cy",
			issues: "https://x/issues",
			message: "Plain",
		});
		assert.equal(gitOrigin({ message: "Written in abso (#39)" }), undefined);
	});

	it("names each #N once, and leaves owner/repo#N alone", () => {
		assert.deepEqual(issueNumbers("see #39 and #4, again #39; other/repo#7, a#5"), [39, 4]);
		assert.deepEqual(issueLinks("(#39)", "https://g/o/r/issues"), ["#39 is https://g/o/r/issues/39"]);
		assert.deepEqual(issueLinks("(#39)", undefined), []);
	});

	it("finds a remote's issues on GitHub or GitLab, by https or ssh", () => {
		assert.equal(issuesOf("https://github.com/o/r.git"), "https://github.com/o/r/issues");
		assert.equal(issuesOf("git@github.com:o/r.git"), "https://github.com/o/r/issues");
		assert.equal(issuesOf("https://gitlab.com/g/sub/r"), "https://gitlab.com/g/sub/r/-/issues");
		assert.equal(issuesOf("https://example.com/o/r.git"), undefined);
		assert.equal(issuesOf(""), undefined);
	});
});
