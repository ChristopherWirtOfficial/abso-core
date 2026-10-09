// Test helpers for the git view: temp dirs, a person using the git CLI with an
// isolated config, and readers for commit trees and working trees.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCommit, resolveRef } from "isomorphic-git";
import { canonicalText } from "../../engine/index.ts";
import { gitContext, readTreeFiles } from "../index.ts";

const made: string[] = [];

/** A fresh empty temp directory, removed by `cleanup()`. */
export function tempDir(name = "gitview"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
	made.push(dir);
	return dir;
}

/** A path inside a fresh temp directory that doesn't exist yet. */
export function freshPath(name = "repo"): string {
	return path.join(tempDir(), name);
}

export function cleanup(): void {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

// An empty global config, so the person's git ignores the machine's settings
// (autocrlf, hooks, LFS filters, signing).
let emptyConfig: string | undefined;
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	if (emptyConfig === undefined) {
		emptyConfig = path.join(tempDir("gitconfig"), "config");
		fs.writeFileSync(emptyConfig, "");
	}
	return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, ...extra };
}

/** Run git in `cwd` and return its stdout. */
export function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
		cwd,
		env: gitEnv(env),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Someone with ordinary git: clones a view, edits files, commits. */
export class Person {
	readonly name: string;
	readonly email: string;
	readonly dir: string;
	/** Seconds since the epoch; each commit is one minute after the last. */
	#clock: number;

	constructor(name: string, dir: string, start = 1_700_000_000) {
		this.name = name;
		this.email = `${name.toLowerCase()}@example.com`;
		this.dir = dir;
		this.#clock = start;
	}

	static clone(name: string, from: string, start?: number): Person {
		const dir = freshPath("clone");
		git(path.dirname(dir), ["clone", "--quiet", from, dir]);
		return new Person(name, dir, start);
	}

	write(file: string, text: string | Uint8Array): void {
		const full = path.join(this.dir, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, text);
	}

	read(file: string): string {
		return fs.readFileSync(path.join(this.dir, file), "utf8");
	}

	/** Replace the 1-based line `n` of a file. */
	setLine(file: string, n: number, text: string): void {
		const lines = this.read(file).split("\n");
		lines[n - 1] = text;
		this.write(file, lines.join("\n"));
	}

	remove(file: string): void {
		git(this.dir, ["rm", "--quiet", file]);
	}

	/** Stage everything and commit. Returns the new commit's sha. */
	commit(message: string): string {
		return this.#commit(["-m", message]);
	}

	/** Stage everything and amend the last commit, keeping its message. */
	amend(): string {
		return this.#commit(["--amend", "--no-edit"]);
	}

	#commit(args: readonly string[]): string {
		const date = `${this.#clock} +0000`;
		this.#clock += 60;
		git(this.dir, ["add", "--all"]);
		git(this.dir, ["commit", "--quiet", "--allow-empty", ...args], {
			GIT_AUTHOR_NAME: this.name,
			GIT_AUTHOR_EMAIL: this.email,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_NAME: this.name,
			GIT_COMMITTER_EMAIL: this.email,
			GIT_COMMITTER_DATE: date,
		});
		return this.head();
	}

	head(): string {
		return git(this.dir, ["rev-parse", "HEAD"]).trim();
	}

	/** The author time of the last commit, in ms. */
	lastTime(): number {
		return (this.#clock - 60) * 1000;
	}
}

/** Text files of a commit (path -> canonical text), read with isomorphic-git. */
export async function commitFiles(dir: string, ref: string): Promise<Record<string, string>> {
	const ctx = gitContext(dir);
	const oid = await resolveRef({ fs, dir, ref });
	const { commit } = await readCommit({ fs, dir, oid });
	const { files } = await readTreeFiles(ctx, commit.tree);
	return Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Text files of a working tree (path -> canonical text), skipping .git and empty or binary files. */
export function workingFiles(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (rel: string): void => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.name === ".git") continue;
			if (entry.isDirectory()) walk(name);
			else {
				const bytes = fs.readFileSync(path.join(dir, name));
				if (bytes.length === 0 || bytes.includes(0)) continue;
				out[name] = canonicalText(bytes.toString("utf8"));
			}
		}
	};
	walk("");
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Sort a path -> text record by path (so deepEqual compares content, not key order). */
export function sorted(files: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Numbered lines "<prefix> 1" .. "<prefix> n", as file text. */
export function numbered(prefix: string, n: number): string {
	return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");
}
