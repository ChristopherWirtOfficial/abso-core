// The client's ignore rules against real git: every file and folder in a
// tree of tricky ignore files gets the same answer from loadIgnore as from
// `git check-ignore`, down to the line that decided.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { parseIgnore } from "../src/core.ts";
import { loadIgnore } from "../src/folder.ts";
import { main } from "../src/main.ts";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
	const d = mkdtempSync(join(tmpdir(), "avcs-ignore-"));
	dirs.push(d);
	return d;
}

function write(root: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		const full = join(root, ...rel.split("/"));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

/** Every file and folder under root, except .git, as [path, isDir]. */
function everything(root: string, prefix = ""): [string, boolean][] {
	const out: [string, boolean][] = [];
	for (const e of readdirSync(join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
		const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
		if (rel === ".git") continue;
		out.push([rel, e.isDirectory()]);
		if (e.isDirectory()) out.push(...everything(root, rel));
	}
	return out;
}

interface GitAnswer {
	readonly source: string;
	readonly line: string;
	readonly pattern: string;
}

/** `git check-ignore -v -n` for each path, with git's global files under home. */
function gitAnswers(root: string, home: string, paths: readonly string[], ignoreCase = false): Map<string, GitAnswer> {
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
	const r = spawnSync(
		"git",
		["-c", `core.ignorecase=${ignoreCase}`, "check-ignore", "-v", "-n", "-z", "--no-index", "--stdin"],
		{
			cwd: root,
			env,
			input: paths.join("\0") + "\0",
			encoding: "utf8",
		},
	);
	assert.ok(r.status === 0 || r.status === 1, r.stderr);
	const f = r.stdout.split("\0");
	const out = new Map<string, GitAnswer>();
	for (let i = 0; i + 3 < f.length; i += 4)
		out.set(f[i + 3]!, { source: f[i]!.replace(/\\/g, "/"), line: f[i + 1]!, pattern: f[i + 2]! });
	return out;
}

function gitInit(root: string, home: string): void {
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
	assert.equal(spawnSync("git", ["init", "-q"], { cwd: root, env }).status, 0);
}

const ROOT_GITIGNORE = [
	"# a comment",
	"*.log",
	"!keep.log",
	"/root-only.txt",
	"build/",
	"docs/**/*.tmp",
	"**/cache",
	"a/**/z",
	"logs/**",
	"!logs/important/",
	"trailing-space.txt   ",
	"with\\ space.txt",
	"\\#hash.txt",
	"\\!bang.txt",
	"[abc].c",
	"[!x]y.c",
	"file?.md",
	"*.[oa]",
	"foo/bar/",
	"deep/*.txt",
	"data/[[:digit:]]*.csv",
	"!ok.bak",
	"mid*dle/x",
	"",
].join("\n");

/** The tree for the comparison, with git's global excludes under home and a .git/info/exclude. */
function tree(root: string, home: string): void {
	write(root, {
		".gitignore": ROOT_GITIGNORE,
		"keep.log": "x",
		"other.log": "x",
		"sub/inner.log": "x",
		"sub/keep.log": "x",
		"root-only.txt": "x",
		"sub/root-only.txt": "x",
		"build/out.js": "x",
		"build/.gitignore": "!*.keep\n",
		"build/x.keep": "x",
		"src/build/y.js": "x",
		"docs/a.tmp": "x",
		"docs/one/two/b.tmp": "x",
		"docs/one/two/b.md": "x",
		"docs/inner/.gitignore": "!x.tmp\n",
		"docs/inner/x.tmp": "x",
		"docs/inner/y.tmp": "x",
		"cache/c1": "x",
		"src/deep/cache/c2": "x",
		"a/z": "x",
		"a/b/c/z": "x",
		"b/a/z": "x",
		"logs/l1.txt": "x",
		"logs/important/i.txt": "x",
		"logs/other/o.txt": "x",
		"trailing-space.txt": "x",
		"with space.txt": "x",
		"#hash.txt": "x",
		"!bang.txt": "x",
		"a.c": "x",
		"d.c": "x",
		"ay.c": "x",
		"xy.c": "x",
		"file1.md": "x",
		"file10.md": "x",
		"m.o": "x",
		"m.a": "x",
		"m.b": "x",
		"foo/bar/x.txt": "x",
		"other/foo/bar/y.txt": "x",
		"deep/a.txt": "x",
		"deep/sub/b.txt": "x",
		"data/1a.csv": "x",
		"data/a1.csv": "x",
		"mid-and-dle/x": "x",
		"mid/dle/x": "x",
		"src/.gitignore": "*.gen.ts\n!keep.gen.ts\n/local.txt\nsub/\n",
		"src/a.gen.ts": "x",
		"src/keep.gen.ts": "x",
		"src/local.txt": "x",
		"src/x/local.txt": "x",
		"src/sub/s.ts": "x",
		"sub2/sub/s.ts": "x",
		"secret.key": "x",
		"public.key": "x",
		"v.bak": "x",
		"ok.bak": "x",
		".env": "x",
		// Names that match only when case is ignored (no two differ only by case, for Windows and macOS disks).
		"X.LOG": "x",
		"sub3/KEEP.LOG": "x",
		"sub3/BUILD/b.js": "x",
		"B.C": "x",
		"N.O": "x",
		"FILE2.MD": "x",
		"src/Cache/c4": "x",
		"src/B.GEN.TS": "x",
		"W.BAK": "x",
		"Shown.KEY": "x",
	});
	write(home, { ".config/git/ignore": "*.bak\n.env\n" });
	gitInit(root, home);
	write(root, { ".git/info/exclude": "*.key\n!public.key\n" });
}

describe("ignore rules", { skip: hasGit ? false : "git is not installed" }, () => {
	// abso matches every rule by pathKey (#49), so it answers as git does with core.ignorecase=true.
	{
		const ignoreCase = true;
		it("give the same answer as git check-ignore with core.ignorecase=true for every path, with the same deciding line", () => {
			const root = temp();
			const home = temp();
			tree(root, home);
			const paths = everything(root);
			const git = gitAnswers(
				root,
				home,
				paths.map(([p]) => p),
				ignoreCase,
			);
			const ignore = loadIgnore(root, { home, xdgConfigHome: join(home, ".config") });
			const wrong: string[] = [];
			for (const [rel, isDir] of paths) {
				const g = git.get(rel);
				assert.ok(g, `git said nothing about ${rel}`);
				const m = ignore.why(rel, isDir);
				const gitIgnored = g.pattern !== "" && !g.pattern.startsWith("!");
				const ours = m.rule
					? `${m.rule.source.includes(":") || m.rule.source.startsWith("/") ? "GLOBAL" : m.rule.source}:${m.rule.line}:${m.rule.pattern}`
					: "::";
				const theirs = g.source.endsWith("/.config/git/ignore")
					? `GLOBAL:${g.line}:${g.pattern}`
					: `${g.source}:${g.line}:${g.pattern}`;
				if (m.ignored !== gitIgnored || ours !== theirs)
					wrong.push(
						`${rel}${isDir ? "/" : ""}: git ${theirs} (${gitIgnored ? "ignored" : "kept"}), avcs ${ours} (${m.ignored ? "ignored" : "kept"})`,
					);
			}
			assert.deepEqual(wrong, []);
			assert.ok(paths.length > 90, `only ${paths.length} paths`);
			if (ignoreCase) {
				// The case-only names really do flip: git answers differently for them with core.ignorecase=false,
				// where abso leaves out more than git status does.
				const strict = gitAnswers(
					root,
					home,
					paths.map(([p]) => p),
					false,
				);
				const ignoredBy = (a: Map<string, GitAnswer>, p: string) =>
					a.get(p)!.pattern !== "" && !a.get(p)!.pattern.startsWith("!");
				const flipped = paths.filter(([p]) => ignoredBy(git, p) !== ignoredBy(strict, p)).length;
				assert.ok(flipped >= 8, `only ${flipped} paths depend on case`);
			}
		});
	}

	it("ignore case whatever core.ignorecase says, in a git repository or outside one (#49)", () => {
		const repo = temp();
		const home = temp();
		write(repo, { ".gitignore": "*.log\n", "A.LOG": "x" });
		gitInit(repo, home);
		for (const set of ["true", "false"]) {
			write(repo, { ".git/config": `[core]\n\tignorecase = ${set}\n` });
			assert.equal(loadIgnore(repo, { home })("A.LOG", false), true, `core.ignorecase=${set}`);
		}
		const plain = temp();
		write(plain, { ".gitignore": "*.log\n" });
		assert.equal(loadIgnore(plain, { home })("A.LOG", false), true);
	});

	it("agree with git on the root `**` with `!*/` and `!*.*` (everything but dotted names and folders)", () => {
		const root = temp();
		const home = temp();
		write(root, { ".gitignore": "**\n!*/\n!*.*\n", Makefile: "x", "a.txt": "x", "d/LICENSE": "x", "d/b.md": "x" });
		gitInit(root, home);
		const paths = everything(root);
		const git = gitAnswers(
			root,
			home,
			paths.map(([p]) => p),
		);
		const ignore = loadIgnore(root, { home });
		for (const [rel, isDir] of paths) {
			const g = git.get(rel)!;
			assert.equal(ignore(rel, isDir), g.pattern !== "" && !g.pattern.startsWith("!"), rel);
		}
	});

	it("let .avcsignore beat .gitignore in the same folder, like lines later in one file", () => {
		const root = temp();
		const home = temp();
		write(root, {
			".gitignore": "*.txt\nout/\n",
			".avcsignore": "!keep.txt\n*.md\n",
			"src/.avcsignore": "!*.md\n",
			"a.txt": "x",
			"keep.txt": "x",
			"a.md": "x",
			"src/b.md": "x",
			"out/o.js": "x",
		});
		// git's twin: each folder's .avcsignore lines appended to its .gitignore.
		const twin = temp();
		write(twin, {
			".gitignore": "*.txt\nout/\n!keep.txt\n*.md\n",
			"src/.gitignore": "!*.md\n",
			"a.txt": "x",
			"keep.txt": "x",
			"a.md": "x",
			"src/b.md": "x",
			"out/o.js": "x",
		});
		gitInit(twin, home);
		const ignore = loadIgnore(root, { home });
		const paths = everything(twin).filter(([p]) => !p.endsWith(".gitignore"));
		const git = gitAnswers(
			twin,
			home,
			paths.map(([p]) => p),
		);
		for (const [rel, isDir] of paths) {
			const g = git.get(rel)!;
			assert.equal(ignore(rel, isDir), g.pattern !== "" && !g.pattern.startsWith("!"), rel);
		}
		assert.equal(ignore.why("keep.txt", false).rule?.source, ".avcsignore");
		assert.equal(ignore.why("src/b.md", false).rule?.source, "src/.avcsignore");
	});

	it("always skip .git, .avcs, .claude and node_modules", () => {
		const ignore = loadIgnore(temp(), {});
		assert.equal(ignore.why(".claude/scheduled_tasks.lock", false).alwaysSkipped, ".claude");
		assert.equal(ignore.why("a/node_modules/m/i.js", false).alwaysSkipped, "a/node_modules");
		assert.equal(ignore("src/a.ts", false), false);
	});

	it("parse escapes, comments, trailing spaces and CRLF like git", () => {
		const rules = parseIgnore("﻿# c\r\n\\#a\r\nb  \r\nc\\ \r\n!\r\n/\r\n\r\n", "", ".gitignore");
		assert.deepEqual(
			rules.map((r) => [r.line, r.pattern]),
			[
				[2, "\\#a"],
				[3, "b"],
				[4, "c\\ "],
			],
		);
	});

	it("abso check-ignore names the deciding line, the ignored folder above, or no rule", async () => {
		const root = temp();
		write(root, {
			".avcs/config.json": "{}",
			".gitignore": "*.log\n!keep.log\nbuild/\n",
			"src/.avcsignore": "gen/\n",
			"build/x/a.txt": "x",
			"src/gen/g.ts": "x",
		});
		const env = { cwd: join(root, "src"), env: { HOME: temp() }, write: () => {} };
		const r = await main(
			["check-ignore", "../a.log", "../keep.log", "../build/x/a.txt", "gen", "a.ts", "../.claude/x", "--json"],
			env,
		);
		assert.equal(r.exit, 0, r.stderr);
		const paths = JSON.parse(r.stdout).paths;
		assert.deepEqual(
			paths.map((p: any) => [
				p.path,
				p.ignored,
				p.source ?? p.alwaysSkipped ?? null,
				p.line ?? null,
				p.because ?? null,
			]),
			[
				["a.log", true, ".gitignore", 1, null],
				["keep.log", false, ".gitignore", 2, null],
				["build/x/a.txt", true, ".gitignore", 3, "build"],
				["src/gen", true, "src/.avcsignore", 1, null],
				["src/a.ts", false, null, null, null],
				[".claude/x", true, ".claude", null, null],
			],
		);
		const text = (await main(["check-ignore", "../keep.log", "../build/x/a.txt"], env)).stdout;
		assert.match(text, /^keep\.log: not ignored: \.gitignore:2 "!keep\.log" brings it back$/m);
		assert.match(text, /^build\/x\/a\.txt: ignored, because its folder build is ignored by \.gitignore:3 "build\/"/m);
	});
});

describe("ignore rules match by the same key as paths (#49)", () => {
	it("catches every spelling abso takes as the same file, from .avcsignore and .gitignore alike", () => {
		const root = temp();
		write(root, {
			".avcsignore": ".env\nsecrets/\n*.KEY\nCaf\u00e9.txt\n[[:upper:]]X.tmp\n",
			"Cfg/.avcsignore": "local.json\n",
			".gitignore": "*.log\n",
		});
		// A folder's ignore file is read under the folder's name on disk, so Cfg/ keeps its spelling here: on a
		// disk that matches case (Linux, CI's box), cfg/.avcsignore isn't Cfg/.avcsignore.
		const ignore = loadIgnore(root, {});
		for (const p of [
			".env",
			".ENV",
			".Env",
			"app/.ENV",
			"SECRETS/a.txt",
			"a.key",
			"b.Key",
			"caf\u00e9.txt",
			"Cafe\u0301.txt",
			"CAF\u00c9.TXT",
			"ax.tmp",
			"Cfg/LOCAL.json",
			"Cfg/local.JSON",
		]) {
			assert.equal(ignore(p, false), true, JSON.stringify(p));
		}
		for (const p of ["env", ".envrc", "cafe.txt", "secretsx/a.txt", "local.json"])
			assert.equal(ignore(p, false), false, JSON.stringify(p));
		assert.equal(ignore.why(".ENV", false).rule?.pattern, ".env");
		// .gitignore too, even where git status matches case exactly.
		assert.equal(ignore("A.LOG", false), true);
	});

	it("the mod's pathKey is the engine's", async () => {
		const engine = await import("../../worker/project/pathkey.ts");
		const { pathKey } = await import("../src/core.ts");
		for (const p of [
			".ENV",
			"Stra\u00dfe.md",
			"caf\u00e9",
			"Cafe\u0301",
			"\u212Aelvin",
			".avc\u017F",
			".g\u0131t",
			"\u0130stanbul",
			"\u01C5",
			"a/B/c.TXT",
		])
			assert.equal(pathKey(p), engine.pathKey(p), JSON.stringify(p));
	});
});
