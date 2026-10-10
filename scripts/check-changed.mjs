// The check for what a change reaches, for running by hand before a publish. The full check (abso.json's)
// still runs on every publish, in the merge queue; this one is only the quick local run, so agents don't run
// the whole suite by hand.
//
//   npm run check:changed [-- file ...]   (paths from the repo root; none: this folder's draft, from abso diff
//                                          and abso status)   --list says what it would run and runs nothing.
//
// What it runs, for the changed files:
// - tests: every test file that imports a changed file, through any number of imports, plus changed test
//   files themselves. A changed file that isn't code (a fixture, a saved log) brings in the test files that
//   name it.
// - typecheck: tsconfig.json, when it includes a changed file or anything that imports one, incrementally
//   (its build info under node_modules/.cache), so a second run reads only what changed.
// - biome: the changed files only.
// A change to setup (package.json, the lockfile, tsconfig.json, abso.json, biome.json) runs the full check.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Test runs: a folder, the test globs its npm test uses (from that folder), and node's extra arguments. */
const TESTS = [
	{
		cwd: ".",
		globs: ["src/**/*.test.ts", "worker/project/**/*.test.ts", "client/test/**/*.test.ts", "scripts/**/*.test.ts"],
		args: ["--import", "./client/test/setup.ts"],
	},
];
/** Typechecks: a tsconfig, from the repo root. */
const TYPECHECKS = [{ tsconfig: "tsconfig.json" }];
/** Files whose change can reach anything: the full check runs instead. */
const SETUP = [
	"**/package.json",
	"**/package-lock.json",
	"**/tsconfig*.json",
	"abso.json",
	"biome.json",
	"biome.jsonc",
	"client/test/setup.ts",
];
const SKIP_DIRS = new Set(["node_modules", ".abso", ".wrangler", "dist", ".git"]);
const CODE = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs"]);

const posix = (p) => p.split(sep).join("/");
const matches = (path, globs) => globs.some((g) => matchesGlob(path, g));

/** Every file under the repo, posix paths from the root, skipping dependency and build folders. */
function allFiles(dir = root, out = []) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		const s = statSync(p);
		if (s.isDirectory()) allFiles(p, out);
		else out.push(posix(relative(root, p)));
	}
	return out;
}

/**
 * Each code file's imports, kept between runs in node_modules/.cache by the file's time and size, so a run
 * reads only the files that changed since the last one.
 */
const CACHE = join(root, "node_modules/.cache/check-changed.json");
function importGraph(code, known) {
	let cache = {};
	try {
		cache = JSON.parse(readFileSync(CACHE, "utf8"));
	} catch {}
	const next = {};
	const importers = new Map();
	for (const f of code) {
		const s = statSync(join(root, f));
		const hit = cache[f];
		const imports = hit && hit.t === s.mtimeMs && hit.n === s.size ? hit.i : importsOf(f, known);
		next[f] = { t: s.mtimeMs, n: s.size, i: imports };
		for (const i of imports) (importers.get(i) ?? importers.set(i, new Set()).get(i)).add(f);
	}
	try {
		mkdirSync(dirname(CACHE), { recursive: true });
		writeFileSync(CACHE, JSON.stringify(next));
	} catch {}
	return importers;
}

/** The files a code file imports, as repo paths (relative imports only; packages can't change in a draft). */
function importsOf(file, known) {
	const text = readFileSync(join(root, file), "utf8");
	const out = [];
	const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
	for (const m of text.matchAll(re)) {
		const base = posix(join(dirname(file), m[1]));
		const stem = base.replace(/\.(m?js|cjs)$/, "");
		for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
			if (known.has(c)) {
				out.push(c);
				break;
			}
	}
	return out;
}

/** This folder's changed files: the draft's, from abso diff, and edits not yet recorded, from abso status. */
function draftFiles() {
	const run = (args) => {
		// One command string: abso is a .cmd on Windows, which needs a shell, and the args are fixed words.
		const r = spawnSync(`abso ${args.join(" ")}`, { cwd: root, encoding: "utf8", shell: true });
		if (r.status !== 0) throw new Error(`abso ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
		return r.stdout;
	};
	const files = new Set();
	for (const m of run(["diff"]).matchAll(/^(?:\+\+\+ b|--- a)\/(.+)$/gm)) files.add(m[1].trim());
	const unrecorded = /^Not yet recorded[^:]*:\s*(.+)$/m.exec(run(["status"]));
	if (unrecorded) for (const f of unrecorded[1].split(/,\s*/)) files.add(f.trim());
	return [...files].filter(Boolean);
}

/** What the changed files reach: test files to run per test group, tsconfigs to check, files for biome. */
export function plan(changed, files = allFiles()) {
	const known = new Set(files);
	if (changed.some((f) => matches(f, SETUP))) return { full: changed.filter((f) => matches(f, SETUP)) };
	const code = files.filter((f) => CODE.has(extname(f)) && !f.endsWith(".d.ts"));
	const importers = importGraph(code, known);
	// Everything that imports a changed file, through any number of imports.
	const reached = new Set(changed.filter((f) => known.has(f)));
	const queue = [...reached];
	while (queue.length)
		for (const by of importers.get(queue.pop()) ?? []) if (!reached.has(by)) reached.add(by), queue.push(by);
	// A changed file that isn't code: the test files that name it.
	const tests = TESTS.map((t) => ({ ...t, files: [] }));
	const owner = (f) =>
		tests.find(
			(t) =>
				(t.cwd === "." || f.startsWith(`${t.cwd}/`)) && matches(t.cwd === "." ? f : f.slice(t.cwd.length + 1), t.globs),
		);
	const allTests = files.filter((f) => owner(f));
	for (const f of changed.filter((c) => known.has(c) && !CODE.has(extname(c)))) {
		const name = f.split("/").pop();
		for (const t of allTests) if (readFileSync(join(root, t), "utf8").includes(name)) reached.add(t);
	}
	for (const f of reached) {
		const t = owner(f);
		if (t) t.files.push(t.cwd === "." ? f : f.slice(t.cwd.length + 1));
	}
	const typechecks = TYPECHECKS.filter((c) => {
		const cfg = ts.readConfigFile(join(root, c.tsconfig), (p) => readFileSync(p, "utf8")).config ?? {};
		const dir = posix(dirname(c.tsconfig));
		const inc = (cfg.include ?? ["**/*"]).map((g) => posix(join(dir, g)));
		const exc = (cfg.exclude ?? []).map((g) => posix(join(dir, g)));
		return [...reached].some((f) => matches(f, inc) && !matches(f, exc));
	});
	const lint = changed.filter((f) => known.has(f) && /\.(m?[jt]sx?|cjs|json|jsonc|css)$/.test(f));
	return { tests: tests.filter((t) => t.files.length), typechecks, lint };
}

/** Runs one command, its output kept, and resolves with its exit and time. */
function runOne(name, cmd, args, cwd) {
	const started = Date.now();
	return new Promise((done) => {
		const child = spawn(cmd, args, { cwd: join(root, cwd) });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => done({ name, code, out, ms: Date.now() - started }));
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const listOnly = argv.includes("--list");
	const given = argv.filter((a) => a !== "--list").map((a) => posix(a).replace(/^\.\//, ""));
	const changed = given.length ? given : draftFiles();
	if (!changed.length) {
		console.log("Nothing changed in this folder: nothing to check.");
		return;
	}
	const p = plan(changed);
	if (p.full) {
		console.log(`Setup changed (${p.full.join(", ")}): running the full check.`);
		if (listOnly) return;
		const { check } = JSON.parse(readFileSync(join(root, "abso.json"), "utf8"));
		const r = spawnSync(check, { cwd: root, stdio: "inherit", shell: true });
		process.exit(r.status ?? 1);
	}
	const jobs = [];
	for (const t of p.tests)
		jobs.push({
			name: `test ${t.cwd} (${t.files.length} files)`,
			cmd: process.execPath,
			args: [...t.args, "--test", ...t.files],
			cwd: t.cwd,
		});
	for (const c of p.typechecks) {
		const info = `node_modules/.cache/tsc/${c.tsconfig.replace(/[/\\]/g, "_")}.tsbuildinfo`;
		jobs.push({
			name: `typecheck ${c.tsconfig}`,
			cmd: process.execPath,
			args: [
				join(root, "node_modules/typescript/bin/tsc"),
				"--noEmit",
				"-p",
				c.tsconfig,
				"--incremental",
				"--tsBuildInfoFile",
				info,
			],
			cwd: ".",
		});
	}
	if (p.lint.length)
		jobs.push({
			name: `biome (${p.lint.length} files)`,
			cmd: process.execPath,
			args: [join(root, "node_modules/@biomejs/biome/bin/biome"), "check", "--no-errors-on-unmatched", ...p.lint],
			cwd: ".",
		});
	console.log(`Changed: ${changed.join(", ")}`);
	for (const j of jobs)
		console.log(
			`  ${j.name}${j.name.startsWith("test") ? `: ${j.args.filter((a) => /\.test\./.test(a)).join(" ")}` : ""}`,
		);
	if (listOnly || !jobs.length) return;
	const started = Date.now();
	const slots = Math.max(1, Number(process.env.ABSO_CHECK_SLOTS) || availableParallelism());
	const results = [];
	for (let i = 0; i < jobs.length; i += slots)
		results.push(...(await Promise.all(jobs.slice(i, i + slots).map((j) => runOne(j.name, j.cmd, j.args, j.cwd)))));
	for (const r of results.filter((r) => r.code !== 0)) console.log(`\n--- ${r.name} failed ---\n${r.out.trimEnd()}`);
	console.log("");
	for (const r of results)
		console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.name}`);
	console.log(`${((Date.now() - started) / 1000).toFixed(1)} s in all. The full check runs when you publish.`);
	if (results.some((r) => r.code !== 0)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
