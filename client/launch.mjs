// Runs abso from a git checkout of it and keeps that checkout current.
//
// Point a command at this file (node <checkout>/client/launch.mjs <args>) and it:
// - runs the client: a plain-JS bundle of it in this process when one matches the checkout's commit,
//   otherwise client/abso.ts in a second node. Node strips types from every client file on every run,
//   so the bundle starts several times faster;
// - at most every 5 minutes, and within 30 seconds of a stale bundle, starts a background step that
//   fast-forwards the checkout (on main only), runs npm install when package-lock.json changed, and
//   builds the bundle. That step never blocks or fails the command, and only one runs at a time.
//
// stdin, stdout, stderr, the arguments and the exit code pass through untouched: the exit codes carry
// meaning (2 refused, 3 still queued). The launcher's own notices go only to ~/.abso/launcher.log.
//
// The bundle is client/dist/abso.mjs, with the commit it was built from in client/dist/abso.mjs.commit.
// It sits one folder under client/, so the client's own folder (client-version.ts) is still client/.
// It is built with esbuild when the checkout has it (in worker/ or at the root): bundled, for node24,
// as an ES module, with no build commit stamped in, since a stamped client calls itself a downloaded
// copy. It is built to a temporary file and renamed into place, and marked current only after every
// require left in it resolves and it runs --version. If it still fails to load, the same run falls
// back to client/abso.ts and writes one line to the log, so edit hooks keep recording.
//
// Plain JS on purpose: this file is loaded on every command, before any bundle.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const state = join(homedir(), ".abso");
const stamp = join(state, "client-update.stamp");
const every = 5 * 60 * 1000;
const bundle = join(repo, "client", "dist", "abso.mjs");
const bundleCommit = `${bundle}.commit`;
/** Set on the background step's own node, which updates the checkout and exits. */
const UPDATE = "ABSO_LAUNCH_UPDATE";
/** Set by the bundle's first line: an error after it came from the command, so it's never run again. */
const STARTED = "__absoBundleStarted";

/** The checkout's commit, read from .git without running git; undefined if it can't be read. */
function headCommit(root = repo) {
	try {
		const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
		if (!head.startsWith("ref:")) return head;
		const ref = head.slice(4).trim();
		try {
			return readFileSync(join(root, ".git", ...ref.split("/")), "utf8").trim();
		} catch {
			const line = readFileSync(join(root, ".git", "packed-refs"), "utf8")
				.split("\n")
				.find((l) => l.endsWith(` ${ref}`));
			return line?.split(" ")[0];
		}
	} catch {
		return undefined;
	}
}

/** Runs fn under a lock folder; a lock older than 10 minutes is a dead run's and is cleared. */
function locked(lock, fn) {
	try {
		if (Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000) rmSync(lock, { recursive: true, force: true });
	} catch {}
	try {
		mkdirSync(lock);
	} catch {
		return;
	}
	try {
		fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** One line in the launcher's log, never on the command's own output. */
function note(text) {
	try {
		mkdirSync(state, { recursive: true });
		appendFileSync(join(state, "launcher.log"), `${new Date().toISOString()} abso launch: ${text}\n`);
	} catch {}
}

/**
 * The background step, one at a time under a lock (a second one finds it taken and exits): fast-forward,
 * install when the lock file moved, then the bundle.
 */
function update() {
	const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", windowsHide: true });
	mkdirSync(state, { recursive: true });
	locked(join(state, "client-update.lock"), () => {
		try {
			if (git("branch", "--show-current").trim() === "main") {
				const before = git("rev-parse", "HEAD").trim();
				git("fetch", "-q", "origin", "main");
				git("merge", "-q", "--ff-only", "origin/main");
				if (git("diff", "--name-only", before, "HEAD", "--", "package-lock.json").trim())
					execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
						cwd: repo,
						stdio: "ignore",
						windowsHide: true,
						shell: true,
					});
			}
		} catch {}
		try {
			build(git("rev-parse", "HEAD").trim());
		} catch (e) {
			note(`the bundle wasn't built (${String(e?.message).split("\n")[0]}); client/abso.ts runs until it is`);
		}
	});
}

/** Builds the bundle for this commit, unless it's already current or the checkout has no esbuild. */
function build(head) {
	try {
		if (readFileSync(bundleCommit, "utf8").trim() === head) return;
	} catch {}
	const require = createRequire(import.meta.url);
	let esbuild;
	try {
		esbuild = require(require.resolve("esbuild", { paths: [join(repo, "worker"), repo] }));
	} catch {
		return;
	}
	const exclude = join(repo, ".git", "info", "exclude");
	try {
		if (!readFileSync(exclude, "utf8").split(/\r?\n/).includes("client/dist/"))
			appendFileSync(exclude, "\nclient/dist/\n");
	} catch {}
	mkdirSync(dirname(bundle), { recursive: true });
	const tmp = bundle.replace(/\.mjs$/, `.${process.pid}.tmp.mjs`);
	try {
		esbuild.buildSync({
			entryPoints: [join(repo, "client", "abso.ts")],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node24",
			outfile: tmp,
			logLevel: "silent",
			// A bundled CommonJS package (yaml) calls require("process") lazily, which an ES module
			// bundle can't do without a real require. The flag says the bundle started running.
			banner: {
				js: `globalThis.${STARTED} = true; import { createRequire as __absoCreateRequire } from "node:module"; const require = __absoCreateRequire(import.meta.url);`,
			},
		});
		const from = createRequire(bundle);
		for (const m of readFileSync(tmp, "utf8").matchAll(/__require\("([^"]+)"\)/g)) from.resolve(m[1]);
		execFileSync(process.execPath, [tmp, "--version"], { cwd: repo, stdio: "ignore", windowsHide: true });
		renameSync(tmp, bundle);
		writeFileSync(bundleCommit, `${head}\n`);
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Runs client/abso.ts in a second node, and exits with its code. */
function runTs() {
	const child = spawn(process.execPath, [join(repo, "client", "abso.ts"), ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/** Starts the background step when it's due: every 5 minutes, or within 30 seconds of a stale bundle. */
function maybeUpdate(fresh) {
	try {
		let last = 0;
		try {
			last = statSync(stamp).mtimeMs;
		} catch {}
		if (Date.now() - last <= (fresh ? every : 30_000)) return;
		mkdirSync(state, { recursive: true });
		writeFileSync(stamp, `${new Date().toISOString()}\n`);
		spawn(process.execPath, [fileURLToPath(import.meta.url)], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: { ...process.env, [UPDATE]: "1" },
		}).unref();
	} catch {}
}

/** The command: the bundle when it matches the checkout, else client/abso.ts. */
async function run() {
	const head = headCommit();
	let fresh = false;
	try {
		fresh = head !== undefined && readFileSync(bundleCommit, "utf8").trim() === head;
	} catch {}
	maybeUpdate(fresh);
	if (!fresh) return runTs();
	// In this process: the client reads its arguments from process.argv, as if run as `node client/dist/abso.mjs`.
	const args = process.argv;
	process.argv = [args[0], bundle, ...args.slice(2)];
	try {
		await import(pathToFileURL(bundle).href);
	} catch (e) {
		// Only a bundle that never started falls back: one that can't be found or parsed, or imports
		// something missing. Anything else came from the command itself, which the .ts would repeat.
		const code = e?.code;
		const loading =
			e instanceof SyntaxError || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME";
		if (!loading || globalThis[STARTED] === true) throw e;
		note(`the bundle didn't load (${code ?? e?.name}: ${String(e?.message).split("\n")[0]}), ran client/abso.ts`);
		process.argv = args;
		runTs();
	}
}

if (process.env[UPDATE] === "1") update();
else await run();
