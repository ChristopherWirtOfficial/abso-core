// Which client this is (#29), for `avcs --version` and for the X-Abso-Client
// header the command-line client sends with each call: plugin.json's version
// plus the commit checked out where the client runs (0.1.0+ed45dad). The
// commit is read from .git without running git, since every command pays for
// its start-up. (The mods carry their own stamp: src/install.ts.)

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * When this client was bundled for a server and that server is now a different
 * commit. Undefined when they match, when the server can't be asked, or when
 * this client runs from a checkout, which abso sync updates and no server serves.
 */
export async function newerCommitNote(server: string): Promise<string | undefined> {
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
