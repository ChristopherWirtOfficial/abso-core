// Canonical paths (#30): every write refuses a path that isn't the one
// spelling of a file, so "./harness/x" can't slip past a filter on
// "harness/" and "../x" can't escape a box's folder. Old logs still load, and
// a file with such a path from before can still be removed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase } from "../../../src/engine/index.ts";
import { MemoryStore, Project, ProjectError, pathProblem } from "../project.ts";

const BAD = [
	"./harness/test262/held-out/zzz.json",
	"harness/./held-out/x.json",
	"harness/../x",
	"../x",
	"a//b",
	"a/",
	"/etc/passwd",
	"C:/x",
	"c:x",
	"a\\b",
	"a\u0000b",
	"a\tb",
	".git/config",
	"sub/.GIT/hooks/x",
];
const GOOD = [
	"harness/test262/held-out/zzz.json",
	"a.ts",
	".gitignore",
	"a/.github/x.yml",
	"dir/..x/y",
	"x..y",
	".a/b",
];

test("pathProblem names every non-canonical form, and passes canonical paths", () => {
	for (const p of BAD) assert.notEqual(pathProblem(p), undefined, JSON.stringify(p));
	for (const p of GOOD) assert.equal(pathProblem(p), undefined, p);
});

const refused = (f: () => unknown): boolean => {
	try {
		f();
	} catch (e) {
		return e instanceof ProjectError && e.code === "bad-request" && /bad file path/.test(e.message);
	}
	return false;
};

test("every write refuses them: init, edit, record (files, modes, blobs), and plain-git intake", () => {
	for (const p of BAD) {
		assert.ok(
			refused(() => new Project(new MemoryStore()).init({ [p]: "x\n" }, 0)),
			`init ${JSON.stringify(p)}`,
		);
		const project = new Project(new MemoryStore(), { hasBlob: () => true });
		project.init({ "a.ts": "a\n" }, 0);
		assert.ok(
			refused(() => project.edit("ann", { file: p, content: "x\n" }, 1)),
			`edit ${JSON.stringify(p)}`,
		);
		assert.ok(
			refused(() => project.record("ann", { [p]: "x\n" }, 1)),
			`record ${JSON.stringify(p)}`,
		);
		assert.ok(
			refused(() => project.record("ann", {}, 1, { [p]: { exec: true } })),
			`modes ${JSON.stringify(p)}`,
		);
		assert.ok(
			refused(() => project.record("ann", {}, 1, {}, { [p]: "a".repeat(64) })),
			`blobs ${JSON.stringify(p)}`,
		);
		assert.ok(
			refused(() =>
				project.ingest(
					{ author: "p", base: 0, commits: [{ sha: "abcdef12", message: "m", files: { "a.ts": "a\n", [p]: "x\n" } }] },
					2,
				),
			),
			`ingest ${JSON.stringify(p)}`,
		);
		assert.deepEqual(project.files(), { "a.ts": "a\n" });
	}
});

test("a log with a non-canonical path from before still loads, reads, and the file can be removed", () => {
	const atom = buildBase(
		{ "./harness/held-out/zzz.json": "{}\n", "a.ts": "a\n" },
		{ author: "init", message: "old", time: 0 },
	);
	const project = Project.load([{ type: "init", atom, time: 0 }], new MemoryStore());
	assert.deepEqual(Object.keys(project.files()), ["./harness/held-out/zzz.json", "a.ts"]);
	assert.equal(project.fileAt("./harness/held-out/zzz.json", 0).text, "{}\n");
	// Writing to it is refused; removing it is not.
	assert.ok(refused(() => project.record("ann", { "./harness/held-out/zzz.json": '{"pass": 1}\n' }, 1)));
	project.record("ann", { "./harness/held-out/zzz.json": null }, 1);
	assert.equal(project.publish("ann", "Remove the stray path", 2).ok, true);
	assert.deepEqual(Object.keys(project.files()), ["a.ts"]);
});

test("paths every agent's disk can hold: no Windows short names, no < > \" | ? *, no part ending in a dot or space (AVCS - Git Lessons, git's CVE-2019-1353)", () => {
	for (const p of [
		"CLAUDE~1/settings.json",
		"GIT~1/hooks/pre-commit",
		"avcs~1/config.json",
		"src/NODE_M~1/x.js",
		"BACKUP~1.TXT",
		"a<b.txt",
		"what?.md",
		"x|y",
		"star*.ts",
		'q"uote',
		".git./config",
		".git /config",
		"docs./a.md",
	]) {
		assert.notEqual(pathProblem(p), undefined, p);
	}
	for (const p of ["src/a~b.ts", "notes/v1.2~draft.md", "longername~1/x", "a.b/c.d", "file.txt"]) {
		assert.equal(pathProblem(p), undefined, p);
	}
});

test("the engine refuses what the client refuses: colons, .git and .avcs in any spelling, invisible characters, device names (AVCS - Security)", () => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "a\n" }, 0);
	const refused = (p: string) =>
		assert.throws(() => project.record("ann", { [p]: "x\n" }, 1), /bad file path|is under \.avcs/, p);
	for (const p of [
		".claude::$INDEX_ALLOCATION/settings.json",
		".git::$INDEX_ALLOCATION/config",
		"a:b",
		"C:/x",
		".AVCS/config.json",
		"sub/.Avcs/x",
		".avc\u017f/config.json",
		".g\u0131t/config",
		".GIT/config",
		".g\u200cit/config",
		".git\ufeff/config",
		"nul.txt",
		"a/CON",
		"com1",
		"LPT9.log",
	])
		refused(p);
	// U+200C/U+200D are ordinary in Persian and Indic names: only a reserved name spelled with them is refused.
	for (const p of [
		"notes/console.md",
		"src/nullable.ts",
		"gitignore.md",
		"avcs.json",
		"docs/.avcsignore-notes.md",
		"src/n\u200came.ts",
		"docs/می\u200cخوام.md",
	]) {
		assert.equal(pathProblem(p), undefined, p);
	}
});
