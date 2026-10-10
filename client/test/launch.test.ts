// client/launch.mjs: which client a run takes, and that a bad bundle never stops a command.
// Each test runs the real launch.mjs from a throwaway git checkout, with a stand-in client, and a home of its own.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const LAUNCH = new URL("../launch.mjs", import.meta.url);
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A checkout on main with one commit, launch.mjs and a stand-in client/abso.ts that names itself. */
function checkout(): { repo: string; home: string; head: string } {
	const root = mkdtempSync(join(tmpdir(), "abso-launch-"));
	roots.push(root);
	const repo = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(repo, "client"), { recursive: true });
	copyFileSync(LAUNCH, join(repo, "client", "launch.mjs"));
	writeFileSync(
		join(repo, "client", "abso.ts"),
		'console.log("ts " + JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(process.env.FAKE_EXIT ?? 0);\n',
	);
	const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "one");
	// A stamp from now: no background step starts during a test.
	mkdirSync(join(home, ".abso"), { recursive: true });
	writeFileSync(join(home, ".abso", "client-update.stamp"), "now\n");
	return { repo, home, head: git("rev-parse", "HEAD").trim() };
}

function bundle(repo: string, text: string, commit: string): void {
	mkdirSync(join(repo, "client", "dist"), { recursive: true });
	writeFileSync(join(repo, "client", "dist", "abso.mjs"), text);
	writeFileSync(join(repo, "client", "dist", "abso.mjs.commit"), `${commit}\n`);
}

function launch(c: { repo: string; home: string }, args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [join(c.repo, "client", "launch.mjs"), ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: c.home, USERPROFILE: c.home, ...env },
	});
}

const NAMES_ITSELF = 'console.log("bundle " + JSON.stringify(process.argv.slice(1)));\n';

describe("client/launch.mjs", () => {
	it("runs client/abso.ts when there's no bundle, with the arguments and exit code passed through", () => {
		const c = checkout();
		const r = launch(c, ["issue", "42"], { FAKE_EXIT: "3" });
		assert.equal(r.stdout.trim(), 'ts ["issue","42"]');
		assert.equal(r.status, 3);
	});

	it("runs the bundle in its own process when it was built from the checkout's commit", () => {
		const c = checkout();
		bundle(c.repo, NAMES_ITSELF, c.head);
		const r = launch(c, ["--version"]);
		assert.equal(
			r.stdout.trim(),
			`bundle ${JSON.stringify([join(c.repo, "client", "dist", "abso.mjs"), "--version"])}`,
		);
		assert.equal(r.status, 0);
	});

	it("runs client/abso.ts when the bundle is from another commit", () => {
		const c = checkout();
		bundle(c.repo, NAMES_ITSELF, "0".repeat(40));
		assert.equal(launch(c, ["status"]).stdout.trim(), 'ts ["status"]');
	});

	it("falls back to client/abso.ts in the same run when the bundle doesn't load, and writes one line", () => {
		const c = checkout();
		bundle(c.repo, "this is not javascript (\n", c.head);
		const r = launch(c, ["log"]);
		assert.equal(r.stdout.trim(), 'ts ["log"]');
		assert.equal(r.status, 0);
		// The launcher's own notice goes to its log only, never on the command's output.
		assert.equal(r.stderr, "");
		const log = readFileSync(join(c.home, ".abso", "launcher.log"), "utf8")
			.trim()
			.split("\n");
		assert.equal(log.length, 1);
		assert.match(log[0]!, /the bundle didn't load \(SyntaxError/);
	});

	it("doesn't run a command twice when it fails inside a bundle that loaded", () => {
		const c = checkout();
		bundle(c.repo, 'throw new Error("the command failed");\n', c.head);
		const r = launch(c, ["push"]);
		assert.notEqual(r.status, 0);
		assert.doesNotMatch(r.stdout, /^ts /m);
		assert.equal(existsSync(join(c.home, ".abso", "launcher.log")), false);
	});

	it("doesn't run a command twice when it throws a SyntaxError after the bundle started", () => {
		const c = checkout();
		bundle(c.repo, 'globalThis.__absoBundleStarted = true;\nJSON.parse("{");\n', c.head);
		const r = launch(c, ["push"]);
		assert.notEqual(r.status, 0);
		assert.doesNotMatch(r.stdout, /^ts /m);
		assert.equal(existsSync(join(c.home, ".abso", "launcher.log")), false);
	});

	it("passes stdin through to the client, from the bundle and from the .ts", () => {
		const c = checkout();
		const echo = 'let s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => console.log("got " + s));\n';
		writeFileSync(join(c.repo, "client", "abso.ts"), echo);
		const fed = (input: string) =>
			spawnSync(process.execPath, [join(c.repo, "client", "launch.mjs")], {
				input,
				encoding: "utf8",
				env: { ...process.env, HOME: c.home, USERPROFILE: c.home },
			}).stdout.trim();
		assert.equal(fed("from the ts"), "got from the ts");
		bundle(c.repo, echo, c.head);
		assert.equal(fed("from the bundle"), "got from the bundle");
	});

	it("runs one background step at a time: a second finds the lock taken and leaves it", () => {
		const c = checkout();
		const lock = join(c.home, ".abso", "client-update.lock");
		mkdirSync(lock);
		assert.equal(launch(c, [], { ABSO_LAUNCH_UPDATE: "1" }).status, 0);
		assert.equal(existsSync(lock), true);
	});

	it("takes over a lock a dead run left behind, and removes it after", () => {
		const c = checkout();
		const lock = join(c.home, ".abso", "client-update.lock");
		mkdirSync(lock);
		const old = new Date(Date.now() - 11 * 60 * 1000);
		utimesSync(lock, old, old);
		assert.equal(launch(c, [], { ABSO_LAUNCH_UPDATE: "1" }).status, 0);
		assert.deepEqual(
			readdirSync(join(c.home, ".abso")).filter((f) => f.includes("lock")),
			[],
		);
	});

	it("reads the commit in a git worktree, where .git is a file", () => {
		const c = checkout();
		const wt = join(c.repo, "..", "wt");
		execFileSync("git", ["-C", c.repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
		bundle(wt, NAMES_ITSELF, c.head);
		const r = launch({ repo: wt, home: c.home }, ["status"]);
		assert.match(r.stdout, /^bundle /);
	});

	it("keeps the background step quiet when it can't fetch or build", () => {
		const c = checkout();
		const r = launch(c, [], { ABSO_LAUNCH_UPDATE: "1" });
		assert.equal(r.status, 0);
		assert.equal(r.stdout, "");
		assert.equal(existsSync(join(c.repo, "client", "dist", "abso.mjs.commit")), false);
	});
});
