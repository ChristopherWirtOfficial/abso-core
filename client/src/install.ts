// Installing a mod without breaking the sessions that run it (#29). The avcs
// mod and avcs-view are folders in Claude Code's skills folder, which every
// session on the machine loads when it starts (an open chat keeps the mod it
// started with, #37). So an install (client/install-mod.ts, client/install-view.ts):
//
//  1. Stages the new files in a temp folder. plugin.json's version gets the
//     last commit that changed the mod's own files (0.1.0+702c616, or
//     0.1.0+702c616.dirty when they differ from it), and hooks/stamp.ts says
//     the same, so the mod sends it with each call to the server
//     (X-Abso-Client). A commit that changes none of them changes nothing to
//     install, and nothing to restart for.
//  2. Checks the staged copy: `claude plugin validate`, then the mod's own
//     tests in Claude Code's plugin test kit. If either fails, nothing in the
//     installed folder changes.
//  3. Keeps each installed file as <file>.prev, then moves each new file into
//     place with a rename, so no session reads a half-written file: what the
//     hook imports first, plugin.json last. If a rename fails, the files
//     already moved are put back.
//
// The renames follow each other within a few milliseconds, but a session can
// still start between two of them. With what the hook imports going in
// first, a new hook never loads without its imports; a core.ts that drops an
// export the old hook uses can fail that one start, and a restart after the
// install brings the whole new mod.
//
// A rollback swaps the .prev files back in, and the files it replaces become
// the .prev ones, so a second rollback undoes the first. .avcs-install.json
// in the mod's folder says what is installed and what the .prev files hold.
// `avcs --version` reports the installed mods (versionReport).

import { spawnSync } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { builtCopy, CLIENT_DIR, clientPlace, clientVersion, headCommit } from "./client-version.ts";

export interface ModSpec {
	/** The mod's name, as its plugin.json has it. */
	readonly name: string;
	/** The folder its files come from. */
	readonly from: string;
	/** Its files, relative to `from`, in the order they go into place: what the hook imports first, plugin.json last. */
	readonly files: readonly string[];
	/** Its tests for the plugin test kit, relative to `from`: staged for the check, never installed. */
	readonly test?: string;
}

/** One install, as .avcs-install.json records it. */
export interface Install {
	readonly version: string;
	/** In the order they went into place. */
	readonly files: readonly string[];
	readonly from: string;
	readonly at: string;
}

export interface InstallRecord extends Install {
	readonly mod: string;
	/** What the .prev files hold. */
	readonly prev?: Install;
	/** Set while files are being moved into place; still set means an install stopped midway. */
	readonly moving?: string;
}

export interface Installed {
	/** False when the folder already had exactly these files. */
	readonly changed: boolean;
	readonly version: string;
	/** The version the .prev files now hold. */
	readonly previous: string | undefined;
	readonly files: number;
}

export interface InstallOptions {
	/** The mod's folder: in the skills folder, or a scratch folder. */
	readonly target: string;
	/** Checks a staged copy of the mod: undefined when it passes, else why not. */
	readonly check: (dir: string) => string | undefined;
	/** For tests: the commit to stamp (null: none), instead of asking git. */
	readonly commit?: string | null;
	/** For tests: the rename that moves each file into place. */
	readonly rename?: (from: string, to: string) => void;
	readonly now?: Date;
}

const RECORD = ".avcs-install.json";
const LOCK = ".avcs-install.lock";
const MANIFEST = ".claude-plugin/plugin.json";
const STAMP_FILE = "hooks/stamp.ts";
/** A lock older than this was left by an install that died. */
const STALE_LOCK_MS = 10 * 60_000;

const at = (dir: string, rel: string, suffix = "") => join(dir, ...rel.split("/")) + suffix;

/** The abso mod: what the hook imports first, plugin.json last. src/core.ts is the only client file it imports. */
export const AVCS_MOD: ModSpec = {
	name: "abso-hooks",
	from: CLIENT_DIR,
	files: ["src/core.ts", "hooks/stamp.ts", "hooks/register.ts", "hooks/hooks.json", ".claude-plugin/plugin.json"],
	test: "hooks/register.test.ts",
};

/** The abso-view mod (#12), from client/view. */
export const VIEW_MOD: ModSpec = {
	name: "abso-view",
	from: join(CLIENT_DIR, "view"),
	files: ["types/index.d.ts", "hooks/stamp.ts", "hooks/register.tsx", "hooks/hooks.json", ".claude-plugin/plugin.json"],
	test: "hooks/register.test.ts",
};

/** The skills folders the mods had before the rename; an install moves them out of the way (see retireOldMod). */
export const OLD_MOD_NAMES: Readonly<Record<string, string>> = { "abso-hooks": "avcs", "abso-view": "avcs-view" };

/** Where Claude Code's skills folder keeps a mod. */
export const skillsFolder = (name: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
	join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills", name);

export const modInstalled = (env: Readonly<Record<string, string | undefined>> = process.env) =>
	existsSync(at(skillsFolder(AVCS_MOD.name, env), MANIFEST)) ||
	existsSync(at(skillsFolder(OLD_MOD_NAMES[AVCS_MOD.name]!, env), MANIFEST));

/**
 * After the new mod is in, the folder it replaces (skills/avcs, skills/avcs-view) would load beside it, so it
 * is moved, not deleted, to ~/.abso/retired-mods/<name>-<stamp>. Returns where it went, or undefined when there was none.
 */
export function retireOldMod(
	spec: ModSpec,
	env: Readonly<Record<string, string | undefined>> = process.env,
	now: Date = new Date(),
): string | undefined {
	const old = OLD_MOD_NAMES[spec.name];
	if (old === undefined) return undefined;
	const from = skillsFolder(old, env);
	if (!existsSync(from)) return undefined;
	const to = join(homedir(), ".abso", "retired-mods", `${old}-${now.toISOString().replace(/[:.]/g, "-")}`);
	mkdirSync(dirname(to), { recursive: true });
	renameRetrying(from, to);
	return to;
}

/** The version an install of `spec` gets: plugin.json's, plus the last commit that changed its files (and .dirty when they differ from it). */
export function versionFor(spec: ModSpec, commit?: string | null): string {
	const manifest = JSON.parse(readFileSync(at(spec.from, MANIFEST), "utf8")) as { version?: unknown };
	const base = String(manifest.version ?? "0.0.0").split("+")[0]!;
	const c = commit === undefined ? modCommit(spec) : commit;
	return c ? `${base}+${c}` : base;
}

function modCommit(spec: ModSpec): string | null {
	const git = (...args: string[]) => spawnSync("git", ["-C", spec.from, ...args], { encoding: "utf8" });
	const last = git("log", "-1", "--format=%H", "--", ...spec.files);
	if (last.status !== 0 || !/^[0-9a-f]{40}/.test(last.stdout)) return null;
	const changed = git("status", "--porcelain", "--", ...spec.files).stdout.trim() !== "";
	return `${last.stdout.slice(0, 7)}${changed ? ".dirty" : ""}`;
}

/** A file changed this close to when an answer was kept can't be told apart from one changed just after it. */
const RACY_MS = 2_000;

interface KeptModCommit {
	readonly head: string;
	readonly files: readonly string[];
	readonly at: number;
	readonly commit: string | null;
}

/**
 * modCommit for the version report, which `abso status` asks on every run: it runs git twice per mod, so
 * the answer is kept in ~/.abso/mod-commits.json. A kept answer holds while the checkout's commit (read
 * from .git, without git) and each of the mod's files (size, modified time, inode) are as they were, and
 * every file was changed clearly before the answer was kept; anything else asks git again. Outside a git
 * checkout there is no commit, and git isn't run at all.
 */
export function keptModCommit(spec: ModSpec, home: string = homedir()): string | null {
	const head = headCommit(spec.from);
	if (head === undefined) return null;
	const at = Date.now();
	const files = spec.files.map((rel) => {
		try {
			const s = statSync(join(spec.from, ...rel.split("/")));
			return `${s.size}:${s.mtimeMs}:${s.ino}`;
		} catch {
			return "-";
		}
	});
	const newest = Math.max(...files.map((f) => (f === "-" ? 0 : Number(f.split(":")[1]))));
	const path = join(home, ".abso", "mod-commits.json");
	const key = `${resolve(spec.from)}|${spec.files.join("|")}`;
	let kept: Record<string, KeptModCommit> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { format?: unknown; mods?: unknown };
		if (parsed.format === 1 && typeof parsed.mods === "object" && parsed.mods !== null)
			kept = parsed.mods as Record<string, KeptModCommit>;
	} catch {}
	const was = kept[key];
	if (
		was !== undefined &&
		was.head === head &&
		Array.isArray(was.files) &&
		was.files.join() === files.join() &&
		newest < was.at - RACY_MS
	)
		return was.commit;
	const commit = modCommit(spec);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const next = `${path}.${process.pid}.tmp`;
		writeFileSync(next, JSON.stringify({ format: 1, mods: { ...kept, [key]: { head, files, at, commit } } }));
		renameSync(next, path);
	} catch {
		// Best effort: the next run asks git again.
	}
	return commit;
}

/** The files to install, stamped with `version`, in install order. */
function filesFor(spec: ModSpec, version: string): Map<string, Buffer> {
	if (!/^[\w.+-]+$/.test(version)) throw new Error(`can't stamp the version ${JSON.stringify(version)}`);
	const out = new Map<string, Buffer>();
	for (const rel of spec.files) {
		let data = readFileSync(at(spec.from, rel));
		if (rel === MANIFEST) {
			const manifest = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
			data = Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
		} else if (rel === STAMP_FILE) {
			const text = data.toString("utf8");
			const stamped = text.replace(/(STAMP[^=\n]*=\s*)undefined/, `$1'${version}'`);
			if (stamped === text) throw new Error(`${rel} has no "STAMP ... = undefined" line to stamp`);
			data = Buffer.from(stamped);
		}
		out.set(rel, data);
	}
	return out;
}

function readRecord(target: string): InstallRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(target, RECORD), "utf8")) as InstallRecord;
	} catch {
		return undefined;
	}
}

function writeRecord(target: string, record: InstallRecord): void {
	writeFileSync(join(target, `${RECORD}.next`), `${JSON.stringify(record, null, 2)}\n`);
	renameRetrying(join(target, `${RECORD}.next`), join(target, RECORD));
}

/** What is installed now. A folder from before .avcs-install.json: the spec's files that are there. */
function installedNow(spec: ModSpec, target: string, record: InstallRecord | undefined): Install | undefined {
	const files = (record?.files ?? spec.files).filter((rel) => existsSync(at(target, rel)));
	if (files.length === 0) return undefined;
	if (record) return { version: record.version, files, from: record.from, at: record.at };
	let version = "unknown";
	try {
		version = String(
			(JSON.parse(readFileSync(at(target, MANIFEST), "utf8")) as { version?: unknown }).version ?? version,
		);
	} catch {}
	return { version, files, from: "unknown", at: "unknown" };
}

/** Sleeps without an event loop, between tries of a rename. */
function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A rename, tried for about a second while Windows says another process has the file open. */
function renameRetrying(from: string, to: string): void {
	for (let i = 0; ; i++) {
		try {
			renameSync(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw err;
			pause(50);
		}
	}
}

/** Holds the mod folder's lock while fn runs. */
function locked<T>(target: string, fn: () => T): T {
	const file = join(target, LOCK);
	try {
		if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) rmSync(file, { force: true });
	} catch {}
	try {
		closeSync(openSync(file, "wx"));
	} catch {
		throw new Error(`another install is running in ${target} (it holds ${LOCK}; if none is, delete that file)`);
	}
	try {
		return fn();
	} finally {
		rmSync(file, { force: true });
	}
}

/**
 * Moves `next` into place in the mod's folder, keeping the files that were
 * there as .prev files. Each file goes in with a rename, in `next`'s order;
 * if one fails, the ones already moved are put back and the error is thrown.
 */
function moveIn(
	spec: ModSpec,
	target: string,
	next: ReadonlyMap<string, Buffer>,
	install: Install,
	rename: (from: string, to: string) => void,
): Install | undefined {
	const record = readRecord(target);
	const current = installedNow(spec, target, record);
	// After an install that stopped midway, the folder is a mix and the .prev files still hold the last whole install.
	const prev = record?.moving ? record.prev : current;
	if (!record?.moving) {
		for (const rel of new Set([...(record?.prev?.files ?? []), ...(current?.files ?? [])]))
			rmSync(at(target, rel, ".prev"), { force: true });
		for (const rel of current?.files ?? []) copyFileSync(at(target, rel), at(target, rel, ".prev"));
	}
	const before: InstallRecord = { mod: spec.name, ...(current ?? install), ...(prev ? { prev } : {}) };
	writeRecord(target, { ...before, moving: install.version });

	const moved: string[] = [];
	try {
		for (const [rel, data] of next) {
			mkdirSync(dirname(at(target, rel)), { recursive: true });
			writeFileSync(at(target, rel, ".next"), data);
		}
		for (const rel of next.keys()) {
			rename(at(target, rel, ".next"), at(target, rel));
			moved.push(rel);
		}
	} catch (err) {
		for (const rel of moved.reverse()) {
			if (prev?.files.includes(rel)) {
				copyFileSync(at(target, rel, ".prev"), at(target, rel, ".next"));
				renameRetrying(at(target, rel, ".next"), at(target, rel));
			} else {
				rmSync(at(target, rel), { force: true });
			}
		}
		for (const rel of next.keys()) rmSync(at(target, rel, ".next"), { force: true });
		if (current) writeRecord(target, before);
		else rmSync(join(target, RECORD), { force: true });
		throw err;
	}
	// Files the old install had and this one doesn't.
	for (const rel of current?.files ?? []) if (!next.has(rel)) rmSync(at(target, rel), { force: true });
	writeRecord(target, { mod: spec.name, ...install, ...(prev ? { prev } : {}) });
	return prev;
}

/** Whether the folder holds exactly `next`. */
function holds(target: string, files: readonly string[], next: ReadonlyMap<string, Buffer>): boolean {
	return (
		files.length === next.size && files.every((rel) => next.get(rel)?.equals(readFileSync(at(target, rel))) ?? false)
	);
}

/** Removes the folders a first install made, if they are empty. */
function removeEmpty(target: string, files: Iterable<string>): void {
	const dirs = new Set<string>();
	for (const rel of files) for (let d = dirname(at(target, rel)); d.length > target.length; d = dirname(d)) dirs.add(d);
	for (const d of [...dirs, target].sort((a, b) => b.length - a.length)) {
		try {
			rmdirSync(d);
		} catch {}
	}
}

/** Installs the mod from `spec.from` into `options.target` (see the top of this file). */
export function installMod(spec: ModSpec, options: InstallOptions): Installed {
	const target = resolve(options.target);
	const version = versionFor(spec, options.commit);
	const next = filesFor(spec, version);
	const existed = existsSync(target);
	mkdirSync(target, { recursive: true });
	try {
		return locked(target, () => {
			const record = readRecord(target);
			const current = installedNow(spec, target, record);
			if (!record?.moving && current && holds(target, current.files, next)) {
				return { changed: false, version, previous: record?.prev?.version, files: next.size };
			}
			const staged = mkdtempSync(join(tmpdir(), `${spec.name}-install-`));
			try {
				for (const [rel, data] of next) {
					mkdirSync(dirname(at(staged, rel)), { recursive: true });
					writeFileSync(at(staged, rel), data);
				}
				const why = options.check(staged);
				if (why !== undefined) throw new Error(`the staged copy failed its check, so nothing was changed:\n${why}`);
			} finally {
				rmSync(staged, { recursive: true, force: true });
			}
			const install: Install = {
				version,
				files: [...next.keys()],
				from: spec.from,
				at: (options.now ?? new Date()).toISOString(),
			};
			const prev = moveIn(spec, target, next, install, options.rename ?? renameRetrying);
			return { changed: true, version, previous: prev?.version, files: next.size };
		});
	} catch (err) {
		// A first install that didn't happen leaves no folder behind.
		if (!existed) removeEmpty(target, next.keys());
		throw err;
	}
}

/** Puts the install kept in the .prev files back; the one it replaces becomes the .prev one. */
export function rollbackMod(spec: ModSpec, options: Pick<InstallOptions, "target" | "rename" | "now">): Installed {
	const target = resolve(options.target);
	if (!existsSync(target)) throw new Error(`nothing is installed in ${target}`);
	return locked(target, () => {
		const record = readRecord(target);
		const prev = record?.prev;
		if (!prev) throw new Error(`no earlier install is kept in ${target}`);
		const missing = prev.files.filter((rel) => !existsSync(at(target, rel, ".prev")));
		if (missing.length > 0)
			throw new Error(
				`the earlier install's ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing from ${target}`,
			);
		const next = new Map(prev.files.map((rel) => [rel, readFileSync(at(target, rel, ".prev"))]));
		const kept = moveIn(spec, target, next, prev, options.rename ?? renameRetrying);
		return { changed: true, version: prev.version, previous: kept?.version, files: next.size };
	});
}

/** `claude plugin validate`, then the mod's own tests in Claude Code's plugin test kit, on a staged copy. */
export function checkWithClaude(spec: ModSpec): (dir: string) => string | undefined {
	// claude is a .cmd on Windows, so it runs through the shell; the folder is quoted.
	const claude = (what: string, dir: string) =>
		spawnSync(`claude plugin ${what} "${dir}"`, { shell: true, encoding: "utf8", timeout: 180_000 });
	const tail = (r: { stdout: string; stderr: string }) =>
		`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
	return (dir) => {
		const valid = claude("validate", dir);
		if (valid.status !== 0) return `claude plugin validate failed (--unchecked skips the check):\n${tail(valid)}`;
		if (spec.test === undefined) return undefined;
		copyFileSync(at(spec.from, spec.test), at(dir, spec.test));
		const tests = claude("test", dir);
		if (tests.status !== 0) return `the mod's tests failed on the staged copy:\n${tail(tests)}`;
		return undefined;
	};
}

/** The installers' command line: [folder] [--rollback] [--unchecked]. */
export function runInstaller(
	spec: ModSpec,
	script: string,
	defaultTarget: string,
	argv: readonly string[] = process.argv.slice(2),
): void {
	const options = argv.filter((a) => a.startsWith("--"));
	const folders = argv.filter((a) => !a.startsWith("--"));
	const unknown = options.find((o) => o !== "--rollback" && o !== "--unchecked");
	if (unknown !== undefined || folders.length > 1) {
		console.error(
			`usage: node client/${script} [folder] [--rollback] [--unchecked]${unknown ? ` (unknown option ${unknown})` : ""}`,
		);
		process.exit(2);
	}
	const target = resolve(folders[0] ?? defaultTarget);
	try {
		if (options.includes("--rollback")) {
			const r = rollbackMod(spec, { target });
			console.log(
				`Rolled the ${spec.name} mod back to ${r.version} in ${target}. ${r.previous ? `${r.previous} is kept; --rollback again puts it back. ` : ""}Restart open chats to load it.`,
			);
			return;
		}
		const unchecked = options.includes("--unchecked");
		const r = installMod(spec, { target, check: unchecked ? () => undefined : checkWithClaude(spec) });
		// Only for the real skills folder: an install to another folder leaves the old mod alone.
		const retired = target === resolve(skillsFolder(spec.name)) ? retireOldMod(spec) : undefined;
		if (retired) console.log(`Moved the old ${OLD_MOD_NAMES[spec.name]} mod out of the skills folder, to ${retired}.`);
		if (!r.changed) {
			console.log(`The ${spec.name} mod ${r.version} is already installed in ${target}; nothing changed.`);
			return;
		}
		const kept = r.previous ? ` The one it replaced (${r.previous}) is kept; --rollback puts it back.` : "";
		console.log(
			`Installed the ${spec.name} mod ${r.version} in ${target} (${r.files} files${unchecked ? ", unchecked" : ", validated and tested first"}).${kept} New chats load it; restart open ones to load it.`,
		);
	} catch (err) {
		console.error(
			`The ${spec.name} mod was not ${options.includes("--rollback") ? "rolled back" : "installed"}: ${(err as Error).message}`,
		);
		process.exit(1);
	}
}

export interface ModInstall {
	readonly name: string;
	readonly folder: string;
	/** Undefined when it isn't installed. */
	readonly version: string | undefined;
	/** When it was installed (mods installed before .avcs-install.json have none). */
	readonly at: string | undefined;
	/** What an install from this client would stamp now. */
	readonly current: string;
}

/** `avcs --version`: this client, and the mods installed on this machine, compared with this client's. */
export function versionReport(env: Readonly<Record<string, string | undefined>>): {
	text: string;
	json: Record<string, unknown>;
} {
	const client = clientVersion();
	const lines = [`abso ${client} (${clientPlace()})`];
	const mods: ModInstall[] = [];
	for (const [spec, installer] of [
		[AVCS_MOD, "install-mod.ts"],
		[VIEW_MOD, "install-view.ts"],
	] as const) {
		const folder = skillsFolder(spec.name, env);
		const field = (rel: string, key: string): string | undefined => {
			try {
				const value = (JSON.parse(readFileSync(at(folder, rel), "utf8")) as Record<string, unknown>)[key];
				return typeof value === "string" ? value : undefined;
			} catch {
				return undefined;
			}
		};
		const m: ModInstall = {
			name: spec.name,
			folder,
			version: field(MANIFEST, "version"),
			at: field(RECORD, "at"),
			current: (() => {
				try {
					return versionFor(spec, keptModCommit(spec));
				} catch {
					return "not in this copy";
				}
			})(),
		};
		mods.push(m);
		// A built copy has no mod files to compare with or install from: it reports what is installed.
		if (m.version === undefined) {
			lines.push(`the ${m.name} mod: not installed${builtCopy() ? "" : ` (node client/${installer})`}`);
			continue;
		}
		const when = m.at ? `, installed ${m.at.slice(0, 16).replace("T", " ")} UTC` : "";
		const behind =
			builtCopy() || m.version === m.current
				? ""
				: `; this client has ${m.current}: node client/${installer} installs it`;
		lines.push(`the ${m.name} mod: ${m.version} in ${m.folder}${when}${behind}`);
	}
	return { text: lines.join("\n"), json: { client, folder: CLIENT_DIR, mods } };
}

/**
 * For `abso status` (abso issue 41: every chat ran a mod a day behind main,
 * and only `--version` would have said so): each installed mod this client
 * would install differently. Says nothing unless this client knows its mod's
 * commit (a git checkout, as the shared one is) and the installed one has one.
 */
export function modsBehindText(env: Readonly<Record<string, string | undefined>>): string[] {
	const installers: Record<string, string> = { [AVCS_MOD.name]: "install-mod.ts", [VIEW_MOD.name]: "install-view.ts" };
	return (versionReport(env).json.mods as ModInstall[])
		.filter((m) => m.version?.includes("+") && /\+[0-9a-f]{7}$/.test(m.current) && m.version !== m.current)
		.map(
			(m) =>
				`The ${m.name} mod installed on this machine is ${m.version}, and this client has ${m.current}: node client/${installers[m.name]} installs it (new chats load it).`,
		);
}
