// Installing a mod (src/install.ts, #29): a staged copy that passed its check
// goes in file by file with renames, plugin.json last; what it replaces is
// kept for a rollback; a failed check or a failed rename leaves the mod as it
// was. Every install here goes into a scratch folder. And which client this
// is (src/version.ts): the commit, read from .git the way git reads it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { Api } from "../src/api.ts";
import { clientVersion, headCommit } from "../src/client-version.ts";
import { installMod, type ModSpec, modsBehindText, rollbackMod, versionFor, versionReport } from "../src/install.ts";
import { main } from "../src/main.ts";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
	const d = mkdtempSync(join(tmpdir(), "avcs-install-test-"));
	dirs.push(d);
	return d;
}

const FILES = ["src/core.ts", "hooks/stamp.ts", "hooks/register.ts", "hooks/hooks.json", ".claude-plugin/plugin.json"];
const pass = () => undefined;
const at = (dir: string, rel: string) => join(dir, ...rel.split("/"));
const read = (dir: string, rel: string) => readFileSync(at(dir, rel), "utf8");
const write = (dir: string, rel: string, text: string) => {
	mkdirSync(dirname(at(dir, rel)), { recursive: true });
	writeFileSync(at(dir, rel), text);
};

/** A mod's source folder: a small mod shaped like avcs, with these texts in place of the defaults. */
function source(texts: Record<string, string> = {}): ModSpec {
	const from = temp();
	const all: Record<string, string> = {
		"src/core.ts": "export const core = 1\n",
		"hooks/stamp.ts": "// Which mod this is.\nexport const STAMP: string | undefined = undefined\n",
		"hooks/register.ts": "import { core } from '../src/core.ts'\n",
		"hooks/hooks.json": '{ "modules": ["./register.ts"] }\n',
		".claude-plugin/plugin.json": '{ "name": "avcs", "version": "0.1.0", "description": "a mod" }\n',
		...texts,
	};
	for (const [rel, text] of Object.entries(all)) write(from, rel, text);
	return { name: "avcs", from, files: FILES };
}

/** Every file under dir, relative and sorted. */
function tree(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)).replace(/\\/g, "/"))
		.sort();
}

const contents = (dir: string) => Object.fromEntries(tree(dir).map((rel) => [rel, read(dir, rel)]));
const record = (dir: string) =>
	JSON.parse(read(dir, ".avcs-install.json")) as {
		version: string;
		files: string[];
		prev?: { version: string; files: string[] };
		moving?: string;
	};

describe("installing a mod", () => {
	it("stamps the version into plugin.json and stamp.ts, and leaves nothing staged behind", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		const r = installMod(spec, { target, check: pass, commit: "702c616" });
		assert.deepEqual(r, { changed: true, version: "0.1.0+702c616", previous: undefined, files: 5 });
		assert.deepEqual(JSON.parse(read(target, ".claude-plugin/plugin.json")), {
			name: "avcs",
			version: "0.1.0+702c616",
			description: "a mod",
		});
		assert.equal(
			read(target, "hooks/stamp.ts"),
			"// Which mod this is.\nexport const STAMP: string | undefined = '0.1.0+702c616'\n",
		);
		assert.equal(read(target, "src/core.ts"), "export const core = 1\n");
		assert.deepEqual(tree(target), [".avcs-install.json", ...FILES].sort());
		assert.deepEqual(
			{ ...record(target), at: undefined, from: undefined },
			{ mod: "avcs", version: "0.1.0+702c616", files: FILES, at: undefined, from: undefined },
		);
	});

	it("moves the files in by rename, what the hook imports first and plugin.json last", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		write(spec.from, "src/core.ts", "export const core = 2\n");
		const order: string[] = [];
		installMod(spec, {
			target,
			check: pass,
			commit: "bbbbbbb",
			rename: (from, to) => {
				assert.ok(from.endsWith(".next"));
				order.push(relative(target, to).replace(/\\/g, "/"));
				renameSync(from, to);
			},
		});
		assert.deepEqual(order, FILES);
	});

	it("checks the staged copy, stamped, and when the check fails changes nothing", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		const before = contents(target);
		write(spec.from, "src/core.ts", "export const core = 2\n");
		let staged = "";
		const failing = (dir: string) => {
			staged = read(dir, "hooks/stamp.ts") + read(dir, "src/core.ts");
			return "2 tests failed";
		};
		assert.throws(
			() => installMod(spec, { target, check: failing, commit: "bbbbbbb" }),
			/failed its check, so nothing was changed:\n2 tests failed/,
		);
		assert.match(staged, /'0\.1\.0\+bbbbbbb'[\s\S]*core = 2/);
		assert.deepEqual(contents(target), before);
	});

	it("leaves no folder behind when a first install fails its check", () => {
		const target = join(temp(), "avcs");
		assert.throws(() => installMod(source(), { target, check: () => "no", commit: "aaaaaaa" }), /nothing was changed/);
		assert.equal(existsSync(target), false);
	});

	it("changes nothing, and checks nothing, when the same files are installed again", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		const mtime = statSync(at(target, "hooks/register.ts")).mtimeMs;
		let checked = false;
		const again = installMod(spec, { target, check: () => ((checked = true), undefined), commit: "aaaaaaa" });
		assert.equal(again.changed, false);
		assert.equal(checked, false);
		assert.equal(statSync(at(target, "hooks/register.ts")).mtimeMs, mtime);
	});

	it("keeps what it replaces; a rollback puts it back, and a second rollback undoes the first", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		write(spec.from, "src/core.ts", "export const core = 2\n");
		const r = installMod(spec, { target, check: pass, commit: "bbbbbbb" });
		assert.equal(r.previous, "0.1.0+aaaaaaa");
		assert.equal(read(target, "src/core.ts.prev"), "export const core = 1\n");

		const back = rollbackMod(spec, { target });
		assert.deepEqual(back, { changed: true, version: "0.1.0+aaaaaaa", previous: "0.1.0+bbbbbbb", files: 5 });
		assert.equal(read(target, "src/core.ts"), "export const core = 1\n");
		assert.equal(JSON.parse(read(target, ".claude-plugin/plugin.json")).version, "0.1.0+aaaaaaa");
		assert.match(read(target, "hooks/stamp.ts"), /'0\.1\.0\+aaaaaaa'/);

		const forward = rollbackMod(spec, { target });
		assert.equal(forward.version, "0.1.0+bbbbbbb");
		assert.equal(read(target, "src/core.ts"), "export const core = 2\n");
		assert.equal(record(target).prev?.version, "0.1.0+aaaaaaa");
	});

	it("puts back the files already moved when a rename fails midway", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		const before = Object.fromEntries(FILES.map((rel) => [rel, read(target, rel)]));
		write(spec.from, "src/core.ts", "export const core = 2\n");
		write(spec.from, "hooks/register.ts", "import { core } from '../src/core.ts'\nexport const two = core\n");
		let n = 0;
		const flaky = (from: string, to: string) => {
			if (++n === 3) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			renameSync(from, to);
		};
		assert.throws(() => installMod(spec, { target, check: pass, commit: "bbbbbbb", rename: flaky }), /EPERM/);
		assert.deepEqual(Object.fromEntries(FILES.map((rel) => [rel, read(target, rel)])), before);
		assert.deepEqual(
			tree(target).filter((f) => f.endsWith(".next")),
			[],
		);
		assert.equal(record(target).version, "0.1.0+aaaaaaa");
		assert.equal(record(target).moving, undefined);
	});

	it("keeps a mod installed before .avcs-install.json for a rollback", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		// The old installer copied four files and wrote nothing else.
		for (const rel of FILES.filter((f) => f !== "hooks/stamp.ts")) {
			mkdirSync(dirname(at(target, rel)), { recursive: true });
			copyFileSync(at(spec.from, rel), at(target, rel));
		}
		const r = installMod(spec, { target, check: pass, commit: "bbbbbbb" });
		assert.equal(r.previous, "0.1.0");
		const back = rollbackMod(spec, { target });
		assert.equal(back.version, "0.1.0");
		assert.equal(JSON.parse(read(target, ".claude-plugin/plugin.json")).version, "0.1.0");
		assert.equal(existsSync(at(target, "hooks/stamp.ts")), false);
	});

	it("after an install that stopped midway, keeps the last whole install for a rollback", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		write(spec.from, "src/core.ts", "export const core = 2\n");
		installMod(spec, { target, check: pass, commit: "bbbbbbb" });
		// An install of ccccccc that died after its first rename: core.ts is new, the rest is bbbbbbb.
		for (const rel of FILES) copyFileSync(at(target, rel), at(target, `${rel}.prev`));
		writeFileSync(
			at(target, ".avcs-install.json"),
			JSON.stringify({ ...record(target), prev: { ...record(target), prev: undefined }, moving: "0.1.0+ccccccc" }),
		);
		write(target, "src/core.ts", "export const core = 3\n");

		write(spec.from, "src/core.ts", "export const core = 4\n");
		const r = installMod(spec, { target, check: pass, commit: "ddddddd" });
		assert.equal(r.previous, "0.1.0+bbbbbbb");
		assert.equal(read(target, "src/core.ts.prev"), "export const core = 2\n");
		rollbackMod(spec, { target });
		assert.equal(read(target, "src/core.ts"), "export const core = 2\n");
	});

	it("refuses while another install holds the lock, and takes over a lock left by one that died", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		write(spec.from, "src/core.ts", "export const core = 2\n");
		const lock = at(target, ".avcs-install.lock");
		writeFileSync(lock, "");
		assert.throws(() => installMod(spec, { target, check: pass, commit: "bbbbbbb" }), /another install is running/);
		assert.throws(() => rollbackMod(spec, { target }), /another install is running/);
		const old = new Date(Date.now() - 11 * 60_000);
		utimesSync(lock, old, old);
		assert.equal(installMod(spec, { target, check: pass, commit: "bbbbbbb" }).changed, true);
		assert.equal(existsSync(lock), false);
	});

	it("says so when there is nothing to roll back to", () => {
		const spec = source();
		const target = join(temp(), "avcs");
		assert.throws(() => rollbackMod(spec, { target }), /nothing is installed/);
		installMod(spec, { target, check: pass, commit: "aaaaaaa" });
		assert.throws(() => rollbackMod(spec, { target }), /no earlier install is kept/);
	});

	it("stamps plugin.json's version plus the last commit that changed the mod's files, and .dirty when they differ from it", {
		skip: !hasGit,
	}, () => {
		const spec = source();
		const git = (...args: string[]) =>
			spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", spec.from, ...args], {
				encoding: "utf8",
			}).stdout.trim();
		git("init", "-q");
		git("add", ".");
		git("commit", "-q", "-m", "mod");
		const mod = git("rev-parse", "--short=7", "HEAD");
		assert.equal(versionFor(spec), `0.1.0+${mod}`);
		// A commit that changes none of the mod's files leaves the stamp, so a reinstall changes nothing.
		write(spec.from, "README.md", "not part of the mod\n");
		assert.equal(versionFor(spec), `0.1.0+${mod}`);
		git("add", ".");
		git("commit", "-q", "-m", "docs");
		assert.equal(versionFor(spec), `0.1.0+${mod}`);
		const target = join(temp(), "avcs");
		installMod(spec, { target, check: pass });
		assert.equal(installMod(spec, { target, check: pass }).changed, false);
		write(spec.from, "src/core.ts", "export const core = 2\n");
		assert.equal(versionFor(spec), `0.1.0+${mod}.dirty`);
		git("commit", "-q", "-am", "core");
		assert.equal(versionFor(spec), `0.1.0+${git("rev-parse", "--short=7", "HEAD")}`);
		// Outside a git checkout there is no commit to add.
		assert.equal(versionFor(spec, null), "0.1.0");
	});
});

describe("which client this is", () => {
	const git = (cwd: string, ...args: string[]) =>
		spawnSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-C", cwd, ...args],
			{ encoding: "utf8" },
		).stdout.trim();

	it("reads the commit from .git as git does: a branch, a packed branch, a detached head, a worktree", {
		skip: !hasGit,
	}, () => {
		const repo = temp();
		git(repo, "init", "-q");
		write(repo, "a/b/file.txt", "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "one");
		assert.equal(headCommit(join(repo, "a", "b")), git(repo, "rev-parse", "--short=7", "HEAD"));
		write(repo, "a/b/file.txt", "two\n");
		git(repo, "commit", "-q", "-am", "two");
		git(repo, "pack-refs", "--all");
		assert.equal(existsSync(join(repo, ".git", "refs", "heads", "main")), false);
		assert.equal(headCommit(repo), git(repo, "rev-parse", "--short=7", "HEAD"));
		const first = git(repo, "rev-parse", "--short=7", "HEAD~1");
		git(repo, "checkout", "-q", "--detach", "HEAD~1");
		assert.equal(headCommit(repo), first);
		const wt = join(temp(), "wt");
		git(repo, "worktree", "add", "-q", "-b", "side", wt, "main");
		write(wt, "a/b/file.txt", "three\n");
		git(wt, "commit", "-q", "-am", "three");
		assert.equal(headCommit(join(wt, "a")), git(wt, "rev-parse", "--short=7", "HEAD"));
		assert.notEqual(headCommit(wt), headCommit(repo));
	});

	it("has no commit outside a repository", () => {
		assert.equal(headCommit(temp()), undefined);
	});

	it("avcs --version names this client's version and the mods installed, and which are from another commit", async () => {
		const config = temp();
		const spec = source();
		installMod(spec, {
			target: join(config, "skills", "avcs"),
			check: pass,
			commit: "aaaaaaa",
			now: new Date("2026-10-05T04:30:00Z"),
		});
		const out = await main(["--version"], { cwd: config, env: { CLAUDE_CONFIG_DIR: config }, write: () => {} });
		const [client, mod, view] = out.stdout.trimEnd().split("\n");
		assert.equal(out.exit, 0);
		assert.equal(client, `abso ${clientVersion()} (${dirname(import.meta.dirname)})`);
		assert.match(
			mod!,
			/^the avcs mod: 0\.1\.0\+aaaaaaa in .*skills[\\/]avcs, installed 2026-10-05 04:30 UTC; this client has 0\.1\.0(\+[0-9a-f]{7}(\.dirty)?)?: node client\/install-mod\.ts installs it$/,
		);
		assert.equal(view, "the avcs-view mod: not installed (node client/install-view.ts)");
		const json = JSON.parse(
			(await main(["--version", "--json"], { cwd: config, env: { CLAUDE_CONFIG_DIR: config }, write: () => {} }))
				.stdout,
		);
		assert.equal(json.client, clientVersion());
		assert.equal(json.mods[0].version, "0.1.0+aaaaaaa");
	});

	it("status says when an installed mod is behind this client, where the client knows its commit (abso issue 41)", () => {
		const config = temp();
		const env = { CLAUDE_CONFIG_DIR: config };
		assert.deepEqual(modsBehindText(env), [], "nothing installed, nothing to say");
		installMod(source(), {
			target: join(config, "skills", "avcs"),
			check: pass,
			commit: "aaaaaaa",
			now: new Date("2026-10-05T04:30:00Z"),
		});
		const current = (versionReport(env).json.mods as { current: string }[])[0]!.current;
		if (/\+[0-9a-f]{7}$/.test(current))
			assert.deepEqual(modsBehindText(env), [
				`The avcs mod installed on this machine is 0.1.0+aaaaaaa, and this client has ${current}: node client/install-mod.ts installs it (new chats load it).`,
			]);
		// A client outside git (an abso folder, a box) can't tell, so it says nothing.
		else assert.deepEqual(modsBehindText(env), []);
	});

	it("the command-line client says which client it is with every call", () => {
		const headers = new Api({
			server: "https://avcs.test",
			project: "p",
			agent: "a",
			token: "t",
		} as ConstructorParameters<typeof Api>[0]).headers("application/json");
		assert.equal(headers["x-avcs-client"], `abso-cli/${clientVersion()}`);
		assert.match(clientVersion(), /^\d+\.\d+\.\d+(\+[0-9a-f]{7})?$/);
	});
});
