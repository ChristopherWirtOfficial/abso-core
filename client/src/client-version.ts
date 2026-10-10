// Which client this is (#29), for `avcs --version` and for the X-Abso-Client
// header the command-line client sends with each call: plugin.json's version
// plus the commit checked out where the client runs (0.1.0+ed45dad). The
// commit is read from .git without running git, since every command pays for
// its start-up. (The mods carry their own stamp: src/install.ts.)

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeWritePath } from "./state-dir.ts";

export const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit checked out in the repository holding `dir`, as 7 hex digits; undefined outside one. */
export function headCommit(dir: string): string | undefined {
	for (let d = resolve(dir); ; d = dirname(d)) {
		const dot = join(d, ".git");
		let isFile: boolean;
		try {
			isFile = statSync(dot).isFile();
		} catch {
			if (dirname(d) === d) return undefined;
			continue;
		}
		try {
			// A worktree's .git is a file naming its folder, whose commondir names the shared one.
			const gitDir = isFile
				? resolve(
						d,
						readFileSync(dot, "utf8")
							.replace(/^gitdir:\s*/, "")
							.trim(),
					)
				: dot;
			let common = gitDir;
			try {
				common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
			} catch {}
			const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
			if (!head.startsWith("ref:")) return short(head);
			const ref = head.slice(4).trim();
			for (const base of [gitDir, common]) {
				try {
					return short(readFileSync(join(base, ...ref.split("/")), "utf8").trim());
				} catch {}
			}
			const packed = readFileSync(join(common, "packed-refs"), "utf8")
				.split("\n")
				.find((line) => line.endsWith(` ${ref}`));
			return packed === undefined ? undefined : short(packed.split(" ")[0]!);
		} catch {
			return undefined;
		}
	}
}

const short = (sha: string) => (/^[0-9a-f]{40,64}$/.test(sha) ? sha.slice(0, 7) : undefined);

/** Set by the staging bundle (abso issue 109). Absent when this file is run from a checkout. */
export function clientPlace(): string {
	return bundledCommit() ? "a downloaded copy" : CLIENT_DIR;
}

function bundledCommit(): string | undefined {
	const stamp = (globalThis as { __ABSO_BUILD_COMMIT__?: unknown }).__ABSO_BUILD_COMMIT__;
	return typeof stamp === "string" && /^[0-9a-f]{7,64}$/.test(stamp) ? stamp.slice(0, 7) : undefined;
}

/** Set by the npm package build: the package's version, such as 0.58.0. Absent everywhere else. */
function packageVersion(): string | undefined {
	const stamp = (globalThis as { __ABSO_PACKAGE_VERSION__?: unknown }).__ABSO_PACKAGE_VERSION__;
	return typeof stamp === "string" && /^\d+\.\d+\.\d+$/.test(stamp) ? stamp : undefined;
}

/** A built copy (the npm package or a downloaded abso.mjs), which has no mods to install from, rather than a checkout. */
export const builtCopy = (): boolean => packageVersion() !== undefined || bundledCommit() !== undefined;

let version: string | undefined;

const NPM_LATEST = "https://registry.npmjs.org/@abso-cli/abso/latest";
const DAY = 24 * 60 * 60 * 1000;

/** Whether x.y.z version a comes after b. */
function laterThan(a: string, b: string): boolean {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

/**
 * For the npm package: npm's latest version when it comes after this one. npm
 * is asked at most once a day, and its answer is kept in ~/.abso/npm-latest.json,
 * so status doesn't wait on the registry each time.
 */
async function newerPackageNote(
	mine: string,
	home: string,
	registry: string,
	now: number,
): Promise<string | undefined> {
	const file = homeWritePath(home, "npm-latest.json");
	let latest: string | undefined;
	try {
		const kept = JSON.parse(readFileSync(file, "utf8")) as { checked?: unknown; latest?: unknown };
		if (typeof kept.checked === "number" && now - kept.checked < DAY && typeof kept.latest === "string")
			latest = kept.latest;
	} catch {}
	if (latest === undefined) {
		try {
			const response = await fetch(registry, { signal: AbortSignal.timeout(3000) });
			const body = (await response.json()) as { version?: unknown };
			if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+$/.test(body.version)) return undefined;
			latest = body.version;
		} catch {
			return undefined;
		}
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify({ checked: now, latest })}\n`);
		} catch {}
	}
	return laterThan(latest, mine)
		? `abso ${latest} is out and this is ${mine}: npm install -g @abso-cli/abso updates it.`
		: undefined;
}

/**
 * When a built copy of this client is behind: the npm package when npm has a
 * later version, or a client bundled for a server when that server is now a
 * different commit. Undefined when it isn't, when the answer can't be had, or
 * when this client runs from a checkout, which abso sync updates.
 */
export async function newerClientNote(
	server: string,
	at: { home?: string; registry?: string; now?: number } = {},
): Promise<string | undefined> {
	const pkg = packageVersion();
	if (pkg) return newerPackageNote(pkg, at.home ?? homedir(), at.registry ?? NPM_LATEST, at.now ?? Date.now());
	const mine = bundledCommit();
	if (!mine) return undefined;
	try {
		const response = await fetch(new URL("/version", server), { signal: AbortSignal.timeout(3000) });
		const body = (await response.json()) as { commit?: unknown };
		const theirs = typeof body.commit === "string" ? body.commit.slice(0, 7) : "";
		if (theirs === "" || theirs === mine) return undefined;
		return `This abso is ${mine} and the server is ${theirs}. Download ${new URL("/client/abso.mjs", server)} and check it against /client/abso.mjs.sha256.`;
	} catch {
		return undefined;
	}
}

/** This client's version: the npm package's (0.58.0), else 0.1.0+ed45dad, or plugin.json's alone outside a git checkout. */
export function clientVersion(): string {
	version ??= packageVersion();
	if (version === undefined) {
		let base = "0.0.0";
		try {
			base = String(
				(JSON.parse(readFileSync(join(CLIENT_DIR, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown })
					.version,
			).split("+")[0]!;
		} catch {}
		const commit = bundledCommit() ?? headCommit(CLIENT_DIR);
		version = commit ? `${base}+${commit}` : base;
	}
	return version;
}
