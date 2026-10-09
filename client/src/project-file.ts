// avcs.json: what the project runs to check and build a version (#39). It is
// recorded and published like any file, so each version carries its own; the
// server's job for each new shared version reads it, and publish --check with
// no command runs its check.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_FILE = "avcs.json";

/** Each key optional; an empty string counts as missing. */
export interface ProjectFile {
	readonly setup: string;
	readonly check: string;
	readonly build: string;
	readonly out: string;
	/** The merge queue (#39): publishes to shared land only once the project's check passes on them. */
	readonly queue?: boolean;
}

const KEYS = ["setup", "check", "build", "out"] as const;

/** The folder's avcs.json, or why it can't be read; null when there is none. */
export function readProjectFile(root: string): { file: ProjectFile } | { error: string } | null {
	const path = join(root, PROJECT_FILE);
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return { error: `${PROJECT_FILE} isn't valid JSON (${(e as Error).message})` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { error: `${PROJECT_FILE} should hold an object, like {"check": "npm test"}` };
	const o = raw as Record<string, unknown>;
	for (const k of KEYS) {
		if (o[k] !== undefined && typeof o[k] !== "string")
			return { error: `"${k}" in ${PROJECT_FILE} should be a string` };
	}
	const get = (k: (typeof KEYS)[number]) => ((o[k] as string | undefined) ?? "").trim();
	return {
		file: {
			setup: get("setup"),
			check: get("check"),
			build: get("build"),
			out: get("out"),
			...(o.queue === true ? { queue: true } : {}),
		},
	};
}

/** npm's placeholder test script, which always fails. */
const NO_TEST = /no test specified/;

/** A starting avcs.json, guessed from package.json; empty where nothing can be guessed. */
export function guessProjectFile(root: string): ProjectFile {
	let pkg: {
		scripts?: Record<string, unknown>;
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
	} = {};
	const hasPkg = existsSync(join(root, "package.json"));
	if (hasPkg) {
		try {
			pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) ?? {};
		} catch {
			pkg = {};
		}
	}
	const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
	const has = (s: string) => typeof scripts[s] === "string" && !(s === "test" && NO_TEST.test(scripts[s] as string));
	const check = has("check")
		? "npm run check"
		: [has("typecheck") ? "npm run typecheck" : "", has("test") ? "npm test" : ""].filter((c) => c !== "").join(" && ");
	const vite = "vite" in (pkg.devDependencies ?? {}) || "vite" in (pkg.dependencies ?? {});
	const build = vite ? "npx --no-install vite build --base ./ --outDir dist" : has("build") ? "npm run build" : "";
	const out = vite ? "dist" : "";
	const setup = existsSync(join(root, "package-lock.json")) ? "npm ci" : hasPkg ? "npm install" : "";
	return { setup, check, build, out };
}

/**
 * Writes a guessed avcs.json when the folder has none and package.json gives
 * a check or a build to guess (#39, Agent VCS: a project with nothing to
 * check shouldn't start boxes; CI skips a version with nothing to run).
 * Answers what it wrote; 'exists' or 'nothing' when it wrote none.
 */
export function writeStartingProjectFile(root: string): ProjectFile | "exists" | "nothing" {
	if (existsSync(join(root, PROJECT_FILE))) return "exists";
	const guess = guessProjectFile(root);
	if (guess.check === "" && guess.build === "") return "nothing";
	writeFileSync(join(root, PROJECT_FILE), `${JSON.stringify(guess, null, 2)}\n`);
	return guess;
}

/** What init says about avcs.json. */
export function startingProjectFileText(wrote: ProjectFile | "exists" | "nothing"): string[] {
	if (wrote === "exists") return [];
	if (wrote === "nothing") {
		return [
			`No ${PROJECT_FILE} written: package.json gives no check or build to guess, so CI has nothing to run on each new version. To give it a check, publish an ${PROJECT_FILE} like {"check": "npm test"} (abso ci --help says what it runs).`,
		];
	}
	const set = KEYS.filter((k) => wrote[k] !== "").map((k) => `${k} "${wrote[k]}"`);
	const empty = KEYS.filter((k) => wrote[k] === "");
	return [
		[
			`Wrote ${PROJECT_FILE}: CI will run on every new version of shared (${set.join(", ")}).`,
			empty.length > 0 ? ` Fill in ${empty.join(", ")} when the project has them.` : "",
			" abso publish --check with no command runs its build and check.",
		].join(""),
	];
}
