// abso blame, why and where: reading who wrote what, and who is working where.
// Blame and why read shared; where reads every agent's unpublished draft.

import { resolve } from "node:path";
import { Api, type BlameAnswer, type Publish, type View } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { globTest } from "./at.ts";
import type { Env, Output } from "./commands.ts";
import { findRoot, readConfig } from "./config.ts";
import { relativeTo } from "./folder.ts";
import { byWhom } from "./history-answers.ts";

function open(env: Env): { root: string; api: Api; agent: string } {
	const root = findRoot(env.cwd);
	if (root === undefined)
		throw new UsageError(`${env.cwd} is not in an abso folder (no .avcs/config.json here or above)`);
	const config = readConfig(root, env.env);
	return { root, api: new Api(config), agent: config.agent };
}

/** A path as typed (relative to where the command runs) to the folder-relative form the server uses. */
export function fileArg(root: string, cwd: string, typed: string): string {
	const rel = relativeTo(root, resolve(cwd, typed));
	if (rel === undefined) throw new UsageError(`${typed} is not inside the abso folder ${root}`);
	return rel;
}

export function when(time: number): string {
	return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function lineNumber(raw: string | undefined, what: string): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) throw new UsageError(`${what} must be a line number (got ${JSON.stringify(raw)})`);
	return n;
}

/** --draft <name> reads a named draft; --mine reads this agent's own view, its unpublished lines marked. */
function viewOf(args: Parsed, agent: string): View {
	const draft = str(args, "draft");
	const mine = bool(args, "mine");
	if (draft !== undefined && mine) throw new UsageError("give --draft or --mine, not both");
	if (mine && str(args, "version") !== undefined)
		throw new UsageError("--mine reads your view as it is now; it takes no --version");
	return mine ? { agent } : draft !== undefined ? { draft } : {};
}

function published(p: Publish | null): string {
	return p === null ? "not published" : `version ${p.version} by ${byWhom(p)} (${when(p.time)}): "${p.message}"`;
}

export async function runBlame(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError("blame takes one file: abso blame <file> [--from <n>] [--to <n>]");
	const { root, api, agent } = open(env);
	const file = fileArg(root, env.cwd, args.positionals[0]!);
	const rawVersion = str(args, "version");
	if (rawVersion !== undefined && !/^\d+$/.test(rawVersion))
		throw new UsageError(`--version is a version number (got ${JSON.stringify(rawVersion)})`);
	const view = viewOf(args, agent);
	const b = await api.blame(
		file,
		lineNumber(str(args, "from"), "--from"),
		lineNumber(str(args, "to"), "--to"),
		rawVersion === undefined ? undefined : Number(rawVersion),
		view,
	);
	const width = Math.max(4, ...b.lines.map((l) => l.author.length));
	const digits = String(b.to).length;
	const versions = new Map<number, string>();
	for (const a of b.atoms) {
		if (a.publish === null) continue;
		const own = a.message && a.message !== a.publish.message ? ` (the change itself: "${a.message}")` : "";
		const line = `  v${a.publish.version} by ${byWhom(a.publish)}, ${when(a.publish.time)}: ${a.publish.message}${own}`;
		if (!versions.has(a.publish.version) || own) versions.set(a.publish.version, line);
	}
	const whose =
		b.agent !== undefined
			? `as your view has it now`
			: b.draft !== undefined
				? `as draft ${b.draft} has it at version ${b.version}`
				: `as shared has it at version ${b.version}`;
	const unpublished = b.lines.some((l) => l.unpublished);
	// A line in a draft but not yet in shared has no shared version: "draft" says where it is.
	const tag = (l: BlameAnswer["lines"][number]) =>
		l.unpublished ? "*" : l.version === null ? "draft" : `v${l.version}`;
	const tagWidth = Math.max(4, ...b.lines.map((l) => tag(l).length));
	const lines = [
		`${b.file} ${whose} (lines ${b.from}-${b.to} of ${b.total}):`,
		...b.lines.map(
			(l) => `  ${String(l.n).padStart(digits)}  ${tag(l).padEnd(tagWidth)} ${l.author.padEnd(width)}  ${l.text}`,
		),
		...(unpublished ? ["", "* not published yet: your own unpublished change."] : []),
		"",
		"Publishes:",
		...[...versions].sort(([x], [y]) => x - y).map(([, line]) => line),
	];
	return { text: lines.join("\n"), json: { ...b } };
}

export async function runWhy(args: Parsed, env: Env): Promise<Output> {
	// abso why <file>:<line>, or abso why <file> <line>
	let typed: string | undefined;
	let raw: string | undefined;
	if (args.positionals.length === 2) [typed, raw] = args.positionals;
	else if (args.positionals.length === 1) {
		const m = /^(.*):(\d+)$/.exec(args.positionals[0]!);
		if (m) [typed, raw] = [m[1], m[2]];
	}
	if (typed === undefined || raw === undefined)
		throw new UsageError("why takes a file and a line: abso why <file>:<line>");
	const { root, api, agent } = open(env);
	const file = fileArg(root, env.cwd, typed);
	const w = await api.why(file, lineNumber(raw, "the line")!, viewOf(args, agent));
	const lines = [
		`${w.file} line ${w.line}: ${w.text}`,
		`Written by ${w.change.author} (${when(w.change.time)}), published in ${published(w.publish)}.`,
		...(w.change.message ? [`The change says: "${w.change.message}"`] : []),
		...(w.settled.length > 0
			? [
					"It settled a collision between:",
					...w.settled.map(
						(s) => `  ${s.author}, ${published(s.publish)}${s.message ? ` (the change: "${s.message}")` : ""}`,
					),
				]
			: []),
		...(w.reasons.length > 0
			? [
					"Its reasons:",
					...w.reasons.map((r) => `  ${r.kind}, about ${r.toAuthor}'s change "${r.toMessage}": ${r.text}`),
				]
			: []),
		...(w.reasonsIn.length > 0
			? [
					"Reasons other changes give about it:",
					...w.reasonsIn.map((r) => `  ${r.fromAuthor} (${r.kind}, "${r.fromMessage}"): ${r.text}`),
				]
			: []),
	];
	return { text: lines.join("\n"), json: { ...w } };
}

function ranges(rs: readonly [number, number][]): string {
	return rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** Whether a starting note's file entry (a path, a folder, or a glob) names `file`. */
function names(entry: string, file: string): boolean {
	try {
		return globTest(entry)(file);
	} catch {
		return false;
	}
}

/**
 * abso who <file...>: for each file, who last changed it, who has unpublished
 * changes in it, and whose starting note names it (#37, Artist 1: "is anyone
 * in here right now?" before touching someone's file).
 */
export async function runWho(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length === 0) throw new UsageError("name the files: abso who <file...>");
	const { root, api, agent } = open(env);
	const files = args.positionals.map((typed) => fileArg(root, env.cwd, typed));
	const w = await api.where();
	const lines: string[] = [];
	const json: Record<string, unknown>[] = [];
	for (const file of files) {
		const last = (await api.log({ agent }, 1, file)).versions[0];
		const drafts = w.files[file] ?? [];
		const notes = (w.starting ?? []).filter((n) => n.files.some((f) => names(f, file)));
		lines.push(
			`${file}:`,
			last
				? `  last changed in version ${last.version} by ${byWhom(last)}, ${when(last.time)}: ${last.message}`
				: "  in no published version yet",
			...(drafts.length > 0
				? drafts.map(
						(s) =>
							`  ${s.agent}${s.agent === agent ? " (you)" : ""} has unpublished changes at lines ${ranges(s.lines) || "(none left)"}, last at ${when(s.lastEdit)}`,
					)
				: ["  nobody has unpublished changes in it"]),
			...notes.map(
				(n) =>
					`  ${n.agent}${n.agent === agent ? " (you)" : ""} started "${n.text}"${n.draft ? ` in draft ${n.draft}` : ""}, ${when(n.time)}`,
			),
		);
		json.push({ file, last: last ?? null, drafts, starting: notes });
	}
	return { text: lines.join("\n"), json: { version: w.version, files: json } };
}

export async function runWhere(_args: Parsed, env: Env): Promise<Output> {
	const { api } = open(env);
	const w = await api.where();
	const files = Object.entries(w.files).sort(([a], [b]) => a.localeCompare(b));
	// Starting notes (#37): what agents said they are taking on, edits or not.
	const notes = (w.starting ?? []).map((n) => {
		const names = n.files.length > 0 ? ` (${n.files.join(", ")})` : "";
		return `  ${n.agent}${n.draft ? ` in draft ${n.draft}` : ""}: "${n.text}"${names}, since ${when(n.time)}`;
	});
	const starting = notes.length > 0 ? ["Starting on:", ...notes] : [];
	if (files.length === 0)
		return {
			text: [`Nobody has unpublished changes. Shared is at version ${w.version}.`, ...starting].join("\n"),
			json: { ...w },
		};
	const lines = [...starting, `Who's working where (shared is at version ${w.version}):`];
	for (const [file, spots] of files) {
		lines.push(`  ${file}`);
		for (const s of spots) {
			const at = s.shared.length > 0 ? `, at shared lines ${ranges(s.shared)}` : "";
			lines.push(
				`    ${s.agent}: lines ${ranges(s.lines) || "(none left)"}${at}; ${s.changes} change${s.changes === 1 ? "" : "s"}, last at ${when(s.lastEdit)}`,
			);
		}
	}
	return { text: lines.join("\n"), json: { ...w } };
}
