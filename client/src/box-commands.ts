// The commands that work in the agent's box: run, prep, bisect, serve, shot, fetch and logs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Api } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { globTest, snapshotAt, snapshotEntries } from "./at.ts";
import { type Env, EXIT, type Output, open, plural } from "./command-env.ts";
import { LISTED, recordFolder } from "./commands.ts";
import { findRoot } from "./config.ts";
import { fromEnv, withOldNames } from "./env-names.ts";
import { fetchedText, fetchFromBox } from "./fetch.ts";
import { absolute, isLocalOnly, loadIgnore, readText, walk, writeFileAtomic } from "./folder.ts";
import { onDisk, PLAIN, readKnownModes } from "./modes.ts";
import { unsafePath } from "./safety.ts";
import { stateDir } from "./state-dir.ts";
import { type TarEntry, tarGz } from "./tar.ts";

/** One word for the box's shell (POSIX sh), quoted only when it needs it. */
export function shellWord(word: string): string {
	return /^[A-Za-z0-9_/.,:=+@%-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line `abso run` sends. After `--` the words are a program and
 * its arguments, each quoted for the box's shell, so quotes, backslashes and
 * regex text reach the program as typed. Without `--` they are a shell
 * command, joined with spaces as before.
 */
export function runCommand(args: Parsed): string {
	if (bool(args, "parallel")) {
		if (args.dashed !== undefined)
			throw new UsageError(
				'--parallel takes each command as one quoted word: abso run --parallel "npm test" "node bench.js"',
			);
		return parallelScript(args.positionals);
	}
	if (args.dashed === 0) return args.positionals.map(shellWord).join(" ");
	return args.positionals.join(" ");
}

/**
 * One sh script that runs the commands at once in the box (one upload, one
 * run): every line a command prints gets its label, [1], [2], ..., stdout
 * staying stdout and stderr staying stderr; then each command's exit code,
 * and the script exits with the worst (highest) of them.
 */
export function parallelScript(commands: readonly string[]): string {
	// awk, flushing every line, so each command's lines arrive as they are printed.
	const tag = (n: number) => `awk '{ print "[${n}] " $0; fflush() }'`;
	const out = ["d=$(mktemp -d)"];
	commands.forEach((c, i) => out.push(`printf '[%s] %s\\n' ${i + 1} ${shellWord(c)}`));
	commands.forEach((c, i) => {
		const n = i + 1;
		// The command's stderr goes through one awk to stderr, its stdout through another to stdout.
		out.push(
			`{ { { sh -c ${shellWord(c)}; echo $? > "$d/${n}"; } 2>&1 1>&3 3>&- | ${tag(n)} 1>&2; } 3>&1 | ${tag(n)}; } &`,
		);
	});
	out.push("wait", "worst=0");
	commands.forEach((c, i) => {
		const n = i + 1;
		out.push(
			`c=$(cat "$d/${n}" 2>/dev/null || echo 1); printf '[%s] exit %s: %s\\n' ${n} "$c" ${shellWord(c)}; if [ "$c" -gt "$worst" ]; then worst=$c; fi`,
		);
	});
	out.push('rm -rf "$d"', "exit $worst");
	return out.join("\n");
}

/**
 * abso run --with <box path>=<local path>[,...]: files for one run only (#37,
 * for A/B runs), sent with the folder and never written to it or
 * recorded. A local folder sends every file under it. Text goes with LF line
 * endings, as the folder's files do.
 */
export function withEntries(spec: string, cwd: string): TarEntry[] {
	const out: TarEntry[] = [];
	for (const pair of spec
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "")) {
		const eq = pair.indexOf("=");
		if (eq <= 0 || eq === pair.length - 1)
			throw new UsageError(
				`--with takes <box path>=<local path> (got ${JSON.stringify(pair)}), like --with _ab/run.ts=../scratch/run.ts`,
			);
		const box = pair.slice(0, eq).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
		const local = resolve(cwd, pair.slice(eq + 1));
		const why = unsafePath(box) ?? (isLocalOnly(box) ? "it is under .git, .claude, .abso or node_modules" : undefined);
		if (why !== undefined) throw new UsageError(`--with can't put a file at ${JSON.stringify(box)}: ${why}`);
		let st;
		try {
			st = statSync(local);
		} catch {
			throw new UsageError(`--with: ${local} doesn't exist`);
		}
		const files = st.isDirectory()
			? readdirSync(local, { recursive: true, withFileTypes: true })
					.filter((e) => e.isFile())
					.map((e) => relative(local, join(e.parentPath, e.name)).split(sep).join("/"))
					.sort()
					.map((rel) => [`${box}/${rel}`, join(local, rel)] as const)
			: [[box, local] as const];
		for (const [path, from] of files) {
			const text = readText(from);
			const data =
				text !== undefined && text.includes("\r") ? Buffer.from(text.replace(/\r\n?/g, "\n")) : readFileSync(from);
			const exec = (statSync(from).mode & 0o111) !== 0 || (data[0] === 0x23 && data[1] === 0x21);
			out.push({ path, data, ...(exec ? { mode: 0o755 } : {}) });
		}
	}
	if (out.length === 0) throw new UsageError("--with named no files");
	return out;
}

/** A word Git Bash made into a Windows path: W:/out, or --out=W:/out. */
const DRIVE_PATH = /^((?:--?[\w.-]+=)?)([A-Za-z]:\/.*)$/;

/** Git's cygpath: each Windows path back to the POSIX one Git Bash made it from, or undefined when it can't. */
function cygpath(paths: readonly string[]): string[] | undefined {
	const r = spawnSync("cygpath", ["-u", "--", ...paths], { encoding: "utf8" });
	const lines = r.status === 0 ? r.stdout.split(/\r?\n/).filter((l) => l !== "") : [];
	return lines.length === paths.length ? lines : undefined;
}

/**
 * Git Bash, every chat's Bash tool on Windows, rewrites a word that starts
 * with / before abso sees it: /w/out arrives as W:/out, /tmp/x as
 * C:/Users/.../Temp/x. No Windows path means anything in the Linux box, so
 * under Git Bash (MSYSTEM set) such words go back to what was typed, by
 * cygpath, which knows Git Bash's mounts. Without it, the run is refused.
 */
export function undoGitBashPaths(
	words: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	toPosix: (paths: readonly string[]) => string[] | undefined = cygpath,
): { words: string[]; undone: { from: string; to: string }[] } {
	if (!env.MSYSTEM || env.MSYS_NO_PATHCONV) return { words: [...words], undone: [] };
	const at = words
		.map((w, i) => [i, DRIVE_PATH.exec(w)] as const)
		.filter((m): m is readonly [number, RegExpExecArray] => m[1] !== null);
	if (at.length === 0) return { words: [...words], undone: [] };
	const back = toPosix(at.map(([, m]) => m[2]!));
	if (back === undefined) {
		throw new UsageError(
			`Git Bash turned ${at.map(([i]) => words[i]).join(", ")} into Windows paths before abso saw them, and they mean nothing in the box. ` +
				"Run it as MSYS_NO_PATHCONV=1 abso run -- ..., or write the path with two slashes (//w/out).",
		);
	}
	const out = [...words];
	const undone = at.map(([i, m], k) => {
		out[i] = `${m[1]}${back[k]}`;
		return { from: words[i]!, to: out[i]! };
	});
	return { words: out, undone };
}

/** abso prep <command>: set up this agent's box once and keep the result as what it starts from (#37). --forget drops it. */
export async function runPrep(args: Parsed, env: Env): Promise<Output> {
	if (bool(args, "forget")) {
		const { api } = open(env);
		api.box = boxOf(args, env);
		const forgot = await api.unprep();
		rememberPrep(findRoot(env.cwd)!, api.box, null);
		return {
			text: forgot ? "Forgot the prep: the box starts from the plain image again." : "The box had no prep.",
			json: { forgot },
		};
	}
	if (args.positionals.length === 0)
		throw new UsageError('give the setup command: abso prep "npm ci && npx playwright install chromium"');
	return runRun(args, env, "prep");
}

/**
 * abso bisect [--good N] [--bad N] -- <check>: the first version of the folder's
 * space where the check fails (#37). Each step is an abso run
 * --at in the box. Without --good it walks back from --bad (newest by default)
 * in doubling steps until a version passes, then halves the gap.
 */
export async function runBisect(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length === 0)
		throw new UsageError("give the check: abso bisect [--good N] [--bad N] -- <program> <arg...>");
	const num = (name: string): number | undefined => {
		const raw = str(args, name);
		if (raw === undefined) return undefined;
		if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} is a version number (got ${JSON.stringify(raw)})`);
		return Number(raw);
	};
	const { api } = open(env);
	const diff = await api.diff();
	const where = { draft: diff.draft };
	let bad = num("bad") ?? (await api.log(where, 1)).version;
	let good = num("good");
	if (good !== undefined && good >= bad) throw new UsageError(`--good (${good}) must be older than --bad (${bad})`);
	const say = env.writeErr ?? env.write;
	const quiet: Env = { ...env, write: () => {}, writeErr: () => {} };
	const tried = new Map<number, number>();
	// Exit 125 means the check can't judge that version (it doesn't build, say), as in git bisect run:
	// it counts neither way. A box or server error throws and ends the bisect.
	const SKIP = 125;
	const test = async (v: number): Promise<"pass" | "fail" | "skip"> => {
		let exit = tried.get(v);
		if (exit === undefined) {
			const flags = new Map(args.flags);
			flags.set("at", String(v));
			flags.delete("good");
			flags.delete("bad");
			exit = (await runRun({ ...args, flags }, { ...quiet, runKind: "bisect" })).exit ?? 0;
			tried.set(v, exit);
			say(
				`abso bisect: version ${v} ${exit === 0 ? "passes" : exit === SKIP ? "can't be tested (exit 125); skipped" : `fails (exit ${exit})`}\n`,
			);
		}
		return exit === 0 ? "pass" : exit === SKIP ? "skip" : "fail";
	};
	const first = await test(bad);
	if (first === "pass")
		return {
			text: `Version ${bad} passes, so there's nothing to find. Give --bad <a version that fails>.`,
			json: { firstBad: null, runs: tried.size },
		};
	if (first === "skip")
		return {
			exit: EXIT.refused,
			text: `--bad ${bad} can't be tested (exit 125): give a version that fails.`,
			json: { firstBad: null, runs: tried.size },
		};
	if (good !== undefined) {
		const g = await test(good);
		if (g !== "pass")
			return {
				exit: EXIT.refused,
				text: `--good ${good} ${g === "skip" ? "can't be tested (exit 125)" : "fails too"}: give a version that passes.`,
				json: { firstBad: null, runs: tried.size },
			};
	} else {
		// Back from bad in doubling steps until one passes; a skipped version moves nothing.
		for (let step = 1; good === undefined; step *= 2) {
			const v = Math.max(0, bad - step);
			const r = await test(v);
			if (r === "pass") good = v;
			else if (v === 0)
				return {
					exit: EXIT.refused,
					text: "No version tried passes, back to version 0: there is no passing version to start from.",
					json: { firstBad: null, runs: tried.size },
				};
			else if (r === "fail") bad = v;
		}
	}
	// Halve the gap; a skipped middle tries its nearest untested neighbour inside the range.
	const skipped = (v: number) => tried.get(v) === SKIP;
	while (bad - good > 1) {
		const mid = Math.floor((good + bad) / 2);
		let pick: number | undefined;
		for (let d = 0; pick === undefined && d < bad - good; d++) {
			for (const c of d === 0 ? [mid] : [mid + d, mid - d]) {
				if (c > good && c < bad && !skipped(c)) {
					pick = c;
					break;
				}
			}
		}
		if (pick === undefined) {
			const space = diff.draft === null ? "shared" : `draft ${diff.draft}`;
			return {
				text: `The first failing version of ${space} is somewhere in ${good + 1}..${bad}: every version between ${good} (passes) and ${bad} (fails) was skipped (exit 125). ${plural(tried.size, "run")} in the box.`,
				json: { firstBad: null, range: [good + 1, bad], lastGood: good, runs: tried.size },
			};
		}
		const r = await test(pick);
		if (r === "pass") good = pick;
		else if (r === "fail") bad = pick;
	}
	const v = await api.show(bad, where);
	const space = diff.draft === null ? "shared" : `draft ${diff.draft}`;
	return {
		text: [
			`First failing version of ${space}: ${bad}, by ${v.agent}: ${v.message}`,
			`  ${plural(v.files.length, "file")}: ${v.files.slice(0, LISTED).join(", ")}${v.files.length > LISTED ? `, and ${v.files.length - LISTED} more` : ""}`,
			`Version ${good} passes. ${plural(tried.size, "run")} in the box. abso show ${bad} has its changes.`,
		].join("\n"),
		json: { firstBad: bad, lastGood: good, agent: v.agent, message: v.message, files: v.files, runs: tried.size },
	};
}

export async function runRun(args: Parsed, env: Env, as: "run" | "prep" = "run"): Promise<Output> {
	if (args.positionals.length === 0)
		throw new UsageError("give the command to run: abso run <command>, or abso run -- <program> <arg...>");
	// A glob before -- next to a list flag is a second value given the wrong way (#37: --fetch 'a' 'b' -- cmd ran "b"
	// as the command, joined with the words after --, which lost their quoting).
	// Once a plain word comes, run keeps the rest as typed, -- included; so the words before a literal -- are the suspects.
	const before = args.dashed !== undefined ? args.dashed : args.positionals.indexOf("--");
	if (before > 0) {
		const listFlag = ["fetch", "files", "with"].find((f) => str(args, f) !== undefined);
		const stray = args.positionals
			.slice(0, before)
			.filter((w) => /[*?[]/.test(w) || (listFlag === "with" && w.includes("=")));
		if (listFlag !== undefined && stray.length > 0) {
			throw new UsageError(
				`${stray.join(" ")} came before -- but isn't part of the command: --${listFlag} takes several values in one argument, comma-separated: --${listFlag} '${[str(args, listFlag), ...stray].join(",")}'`,
			);
		}
	}
	// avcs's own lines (on stderr); --quiet drops them, and the box's stdout and stderr stay as they are (#37).
	const notice = bool(args, "quiet") ? (_text: string): void => {} : (env.writeErr ?? env.write);
	// What the box said about its prep (X-Avcs-Prep): null when it has none.
	let prepState: string | null | undefined;
	const posix = undoGitBashPaths(args.positionals, env.env);
	if (posix.undone.length > 0) {
		args = { ...args, positionals: posix.words };
		notice(
			`abso: Git Bash rewrote ${posix.undone.map((u) => `${u.to} as ${u.from}`).join(", ")}; sending ${posix.undone.map((u) => u.to).join(", ")} to the box. (MSYS_NO_PATHCONV=1 stops Git Bash rewriting.)\n`,
		);
	}
	const command = runCommand(args);
	// The box's sh reads a quoted command once more: point at -- when the text holds what that trips on (Backtracker).
	if (
		args.dashed === undefined &&
		!bool(args, "parallel") &&
		(/\\/.test(command) || (/'/.test(command) && /"/.test(command)))
	) {
		notice(
			"abso: the box's sh reads this command again; if a \\, $ or quote comes out wrong, use abso run -- <program> <args...>, which passes each word as typed.\n",
		);
	}
	// What the run log and --detach call it: the commands, not the script that runs them.
	const named = bool(args, "parallel") ? `--parallel ${args.positionals.map(shellWord).join(" ")}` : command;
	const fetchGlobs = (str(args, "fetch") ?? "")
		.split(",")
		.map((g) => g.trim())
		.filter((g) => g !== "");
	if (fetchGlobs.length > 0 && bool(args, "detach"))
		throw new UsageError(
			"--fetch waits for the run to end; with --detach, fetch later: abso logs <id>, then abso fetch <glob>",
		);
	const rawAt = str(args, "at");
	const filesGlob = str(args, "files");
	if (filesGlob !== undefined && rawAt === undefined)
		throw new UsageError("--files takes old copies from a version: give it with --at <version>");
	if (rawAt !== undefined && !/^\d+$/.test(rawAt))
		throw new UsageError(`--at is a version number (got ${JSON.stringify(rawAt)})`);
	const at = rawAt === undefined ? undefined : Number(rawAt);
	const { root, config, api } = open(env);
	api.box = boxOf(args, env);
	// Stamp the run with what it runs: the draft as recorded, on which version of which space.
	await recordFolder(root, api);
	let stamp = await runStamp(root, config.agent, api);
	let entries: TarEntry[] = [];
	const knownModes = readKnownModes(root);
	// --at without --files sends the version alone; the folder isn't read.
	const folderFiles = at === undefined || filesGlob !== undefined ? walk(root, loadIgnore(root)) : [];
	const toLf: string[] = [];
	for (const rel of folderFiles) {
		const path = absolute(root, rel);
		const d = onDisk(path, knownModes.get(rel) ?? PLAIN);
		if (d === undefined) continue;
		if (d.link !== null) {
			entries.push({ path: rel, data: new Uint8Array(0), link: d.link });
			continue;
		}
		// Text goes as abso records it, with LF line endings: a CRLF script fails in the box's sh (#37).
		const lf = d.text !== undefined && d.text.includes("\r") ? Buffer.from(d.text.replace(/\r\n?/g, "\n")) : undefined;
		if (lf !== undefined) toLf.push(rel);
		const data = lf ?? readFileSync(path);
		// The bit from the disk, or (on Windows) from the server; a script with "#!" runs either way.
		const script = data[0] === 0x23 && data[1] === 0x21;
		entries.push({ path: rel, data, ...(d.exec || script ? { mode: 0o755 } : {}) });
	}
	if (toLf.length > 0) {
		const named =
			toLf.length <= LISTED ? toLf.join(", ") : `${toLf.slice(0, LISTED).join(", ")}, and ${toLf.length - LISTED} more`;
		notice(
			`abso: sent ${plural(toLf.length, "file")} with LF line endings, as abso records them; your folder has CRLF: ${named}.\n`,
		);
	}
	if (at !== undefined) {
		// A past version in the box; the folder's files stay as they are (Backtracker's bisect).
		const snap = await snapshotAt(root, api, at);
		const space = stamp.ABSO_SPACE === "shared" ? "shared" : `draft ${stamp.ABSO_SPACE}`;
		if (filesGlob === undefined) {
			entries = await snapshotEntries(api, snap);
			stamp = { ...stamp, ABSO_VERSION: String(at), ABSO_DRAFT: "0", ABSO_DRAFT_HASH: "", ABSO_AT: String(at) };
			notice(
				`abso: running version ${at} of ${space} in the box (${plural(entries.length, "file")}); your folder is untouched.\n`,
			);
		} else {
			const pick = globTest(filesGlob);
			const old = await snapshotEntries(api, snap, pick);
			const gone = entries.filter((e) => pick(e.path) && !old.some((o) => o.path === e.path)).map((e) => e.path);
			entries = [...entries.filter((e) => !pick(e.path)), ...old].sort((a, b) => a.path.localeCompare(b.path));
			stamp = { ...stamp, ABSO_AT: `${at} files ${filesGlob}` };
			const said =
				old.length === 0 && gone.length === 0
					? `no file matches ${filesGlob} in your folder or at version ${at}`
					: `${plural(old.length, "file")} as at version ${at}: ${old.map((e) => e.path).join(", ")}${gone.length > 0 ? `; left out, not there at version ${at}: ${gone.join(", ")}` : ""}`;
			notice(`abso: running your folder with ${said}. Your folder is untouched.\n`);
		}
	}
	const withSpec = str(args, "with");
	if (withSpec !== undefined) {
		const extra = withEntries(withSpec, env.cwd);
		const paths = new Set(extra.map((e) => e.path));
		entries = [...entries.filter((e) => !paths.has(e.path)), ...extra].sort((a, b) => a.path.localeCompare(b.path));
		const named =
			extra.length <= LISTED
				? extra.map((e) => e.path).join(", ")
				: `${extra
						.slice(0, LISTED)
						.map((e) => e.path)
						.join(", ")}, and ${extra.length - LISTED} more`;
		notice(
			`abso: adding ${plural(extra.length, "file")} for this run only: ${named}. They are not in your folder and are not recorded.\n`,
		);
	}
	if (as === "prep") {
		// The box keeps what the command leaves (node_modules, ~/.cache, /tmp) as what it starts from (#37).
		notice(
			"abso: preparing the box from a fresh image: this takes as long as the command, then a few seconds to save.\n",
		);
		const p = await api.prep(command, tarGz(entries));
		if (p.saved !== true) {
			return {
				text: `Prep failed (exit ${p.exitCode ?? "?"}); the box is as it was. Its output ends:\n${String(p.output ?? p.error ?? "").trimEnd()}`,
				json: { ...p },
				exit: 1,
			};
		}
		rememberPrep(root, api.box, "used");
		return {
			text: [
				`Prepared the box in ${p.seconds} s: ${named}`,
				...String(p.output ?? "")
					.trimEnd()
					.split("\n")
					.slice(-5)
					.map((l) => `  | ${l}`),
				"From now on it starts from this, so a fresh box already has what the command left (node_modules, ~/.cache, /tmp).",
				"abso run says when the prep is set aside (a new box image) or out of date (package-lock.json changed): run abso prep again then. abso run --fresh skips it once; abso prep --forget drops it.",
			].join("\n"),
			json: { ...p },
		};
	}
	// A broken stream reconnects to the run quietly; .abso/run.log says when and why.
	// (Tests shorten the waits with these.)
	const delays = (name: string) =>
		fromEnv(env.env, name)
			?.split(",")
			.map(Number)
			.filter((n) => Number.isFinite(n) && n >= 0);
	const reconnect = delays("RUN_RECONNECT_MS");
	const retry = delays("RUN_RETRY_MS");
	const runner =
		reconnect?.length || retry?.length
			? new Api(api.config, api.timeoutMs, reconnect?.length ? reconnect : undefined, retry?.length ? retry : undefined)
			: api;
	runner.runKind = env.runKind ?? "run";
	runner.box = api.box;
	const log = (what: string, why: string): void => {
		try {
			appendFileSync(join(stateDir(root), "run.log"), `${new Date().toISOString()}\t${what}: ${named}\t${why}\n`);
		} catch {
			// The log is a convenience.
		}
	};
	const onRetry = (why: string, attempt: number) => log(`starting again (try ${attempt + 1}), no answer came`, why);
	if (bool(args, "detach")) {
		const id = await runner.startRun(`${stampPrefix(stamp)}${command}`, tarGz(entries), onRetry, bool(args, "replace"));
		return {
			text: [
				`Started run ${id} in the box: ${named}`,
				`It goes on without this connection. abso logs ${id} prints its output from the start and waits for it to finish, with its exit code.`,
				"While it runs, a later abso run from this folder is refused (409), since it would replace the files under it; abso run --replace stops it first.",
			].join("\n"),
			json: { id, stamp },
		};
	}
	const exit = await runner.run(`${stampPrefix(stamp)}${command}`, tarGz(entries), {
		out: env.write,
		err: env.writeErr ?? env.write,
		onReconnect: (why, attempt) => log(`reconnecting (try ${attempt}) to`, why),
		onRetry,
		replace: bool(args, "replace"),
		fresh: bool(args, "fresh"),
		onBox: (cold, prep) => {
			prepState = prep ?? null;
			rememberPrep(root, api.box, prepState);
			const say = notice;
			if (cold && prep === "used")
				say(
					"abso: fresh box, started from your prep (abso prep): node_modules, ~/.cache and /tmp are as the prep left them.\n",
				);
			else if (cold)
				say(
					"abso: fresh box: it started for this run (first run, a deploy, a new image, or 30 idle minutes), so nothing earlier runs left outside the folder (/tmp, ~/.cache, node_modules) is in it. abso prep keeps them for every fresh box.\n",
				);
			if (prep !== undefined && prep !== "used") say(`abso: prep ${prep}.\n`);
		},
	});
	if (fetchGlobs.length > 0) {
		// On stderr: stdout is the command's, and may be going to a file.
		const fetched = await fetchFromBox(root, api, fetchGlobs);
		notice(`${fetchedText(fetched).join("\n")}\n`);
		return { text: "", json: { exit, stamp, fetched, prep: prepState }, exit };
	}
	return { text: "", json: { exit, stamp, prep: prepState }, exit };
}

/** abso fetch <glob...>: files the box made, written into the folder where abso ignores them. */
/**
 * Which of the agent's boxes run, logs and fetch use (#37): --box <name>, else
 * ABSO_BOX (or the older AVCS_BOX), else the agent's own. A lead can give each subagent its own box
 * (ABSO_BOX=2 in its environment), so their runs don't wait on each other.
 */
/**
 * What this folder last heard about a box's prep: a run's X-Avcs-Prep, or
 * abso prep and prep --forget. null means no prep; undefined, never heard. So
 * publish --check can refuse before running a check that can't be trusted
 * (#37, Artist 1: a 40 s suite ran, then was refused).
 */
function prepFile(root: string): string {
	return join(stateDir(root), "box-prep.json");
}
export function knownPrep(root: string, box: string | undefined): string | null | undefined {
	try {
		const all = JSON.parse(readFileSync(prepFile(root), "utf8")) as Record<string, string | null>;
		const key = box ?? "";
		return key in all ? all[key] : undefined;
	} catch {
		return undefined;
	}
}
function rememberPrep(root: string, box: string | undefined, state: string | null): void {
	let all: Record<string, string | null> = {};
	try {
		all = JSON.parse(readFileSync(prepFile(root), "utf8")) as Record<string, string | null>;
	} catch {
		// First time.
	}
	all[box ?? ""] = state;
	try {
		writeFileAtomic(prepFile(root), `${JSON.stringify(all)}\n`);
	} catch {
		// A convenience.
	}
}

export function boxOf(args: Parsed, env: Env): string | undefined {
	const box = str(args, "box") ?? fromEnv(env.env, "BOX");
	if (box !== undefined && !/^[A-Za-z0-9_-]{1,24}$/.test(box))
		throw new UsageError(`a box name is 1-24 letters, digits, - or _ (got ${JSON.stringify(box)})`);
	return box;
}

/** abso logs <id>: a run's output (a detached one's, or one whose connection was lost) from the start, until it ends. */
export async function runLogs(args: Parsed, env: Env): Promise<Output> {
	const id = args.positionals[0];
	if (args.positionals.length !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(id!))
		throw new UsageError("logs takes one run id: abso logs <id> (abso run --detach prints it)");
	const { root, api } = open(env);
	api.box = boxOf(args, env);
	const exit = await api.logs(id!, {
		out: env.write,
		err: env.writeErr ?? env.write,
		onReconnect: (why, attempt) => {
			try {
				appendFileSync(
					join(stateDir(root), "run.log"),
					`${new Date().toISOString()}\treconnecting (try ${attempt}) to run ${id}\t${why}\n`,
				);
			} catch {
				// The log is a convenience.
			}
		},
	});
	return { text: "", json: { id, exit }, exit };
}

/** What `abso run` tells the command about the code it runs, as environment variables. */
export interface RunStamp {
	readonly ABSO_AGENT: string;
	/** shared, or the named draft. */
	readonly ABSO_SPACE: string;
	/** The version of that space the draft builds on. */
	readonly ABSO_VERSION: string;
	/** How many unpublished changes the draft holds (0: the run is exactly that version). */
	readonly ABSO_DRAFT: string;
	/** A short hash of the draft's files as they are, "" when the draft is empty. */
	readonly ABSO_DRAFT_HASH: string;
	/** With abso run --at: the version run ("12"), or the files taken from it ("12 files src/*.ts"). */
	readonly ABSO_AT?: string;
}

async function runStamp(root: string, agent: string, api: Api): Promise<RunStamp> {
	const status = await api.status();
	const me = status.agents.find((a) => a.agent === agent);
	const files = Array.isArray(me?.files) ? [...(me.files as readonly string[])].sort() : [];
	let hash = "";
	if ((me?.draftChanges ?? 0) > 0) {
		const h = createHash("sha256");
		for (const rel of files) h.update(`${rel}\0${readText(absolute(root, rel)) ?? ""}\0`);
		hash = h.digest("hex").slice(0, 12);
	}
	return {
		ABSO_AGENT: agent,
		ABSO_SPACE: me?.draft ?? "shared",
		ABSO_VERSION: String(me?.base ?? status.version),
		ABSO_DRAFT: String(me?.draftChanges ?? 0),
		ABSO_DRAFT_HASH: hash,
	};
}

/** `export A='x' B='y'; `: on every part of a compound command, unlike a bare assignment prefix. */
function stampPrefix(stamp: RunStamp): string {
	const quote = (v: string) => `'${v.replace(/'/g, `'''`)}'`;
	return `export ${Object.entries(withOldNames({ ...stamp }))
		.filter((e): e is [string, string] => e[1] !== undefined)
		.map(([k, v]) => `${k}=${quote(v)}`)
		.join(" ")}; `;
}
