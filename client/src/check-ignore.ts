// `abso check-ignore`: whether abso leaves a path out, and which line of
// which ignore file decided. The same rules record, publish, sync, run and the
// hook use (core.ts).

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Parsed, UsageError } from "./args.ts";
import type { Env, Output } from "./commands.ts";
import { findRoot } from "./config.ts";
import type { IgnoreMatch } from "./core.ts";
import { gitHome, loadIgnore, relativeTo } from "./folder.ts";

/** Starting .absoignore for `abso init`, when the folder has none. */
export const STARTING_ABSOIGNORE = `# Files abso leaves out, on top of .gitignore. Same rules as .gitignore; this
# file wins over .gitignore in the same folder. \`abso check-ignore <path>\`
# says which line decided. .git, .abso, .avcs, .claude and node_modules are always
# left out.

# Each session's own Claude Code state
.claude/

# Operating system files
.DS_Store
._*
.Spotlight-V100/
.Trashes/
Thumbs.db
ehthumbs.db
desktop.ini
$RECYCLE.BIN/
`;

/** The abso folder around cwd, else the git repository around it, else cwd. */
function rootFor(cwd: string): string {
	const avcs = findRoot(cwd);
	if (avcs !== undefined) return avcs;
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return resolve(cwd);
	}
}

function rule(m: IgnoreMatch): string {
	return m.rule ? `${m.rule.source}:${m.rule.line} "${m.rule.pattern}"` : "";
}

function describe(rel: string, m: IgnoreMatch): string {
	if (m.alwaysSkipped !== undefined) return `${rel}: ignored: abso always leaves out ${m.alwaysSkipped}`;
	if (m.folder !== undefined)
		return `${rel}: ignored, because its folder ${m.folder} is ignored by ${rule(m)}. Nothing inside an ignored folder can be brought back with "!"; un-ignore the folder first.`;
	if (m.rule === undefined) return `${rel}: not ignored (no rule matches)`;
	return m.ignored ? `${rel}: ignored by ${rule(m)}` : `${rel}: not ignored: ${rule(m)} brings it back`;
}

export async function runCheckIgnore(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length === 0) throw new UsageError("give at least one path: abso check-ignore <path...>");
	const root = rootFor(env.cwd);
	const ignore = loadIgnore(root, gitHome(env.env));
	const results = args.positionals.map((arg) => {
		const full = resolve(env.cwd, arg);
		const rel = relativeTo(root, full);
		if (rel === undefined) throw new UsageError(`${arg} is not inside ${root}`);
		let isDir = /[\\/]$/.test(arg);
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			// A path that doesn't exist yet: a trailing slash means a folder.
		}
		return { rel, isDir, match: ignore.why(rel, isDir) };
	});
	return {
		text: results.map(({ rel, match }) => describe(rel, match)).join("\n"),
		json: {
			root,
			paths: results.map(({ rel, isDir, match: m }) => ({
				path: rel,
				folder: isDir,
				ignored: m.ignored,
				...(m.rule ? { source: m.rule.source, line: m.rule.line, pattern: m.rule.pattern } : {}),
				...(m.folder !== undefined ? { because: m.folder } : {}),
				...(m.alwaysSkipped !== undefined ? { alwaysSkipped: m.alwaysSkipped } : {}),
			})),
		},
	};
}
