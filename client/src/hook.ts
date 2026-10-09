// `abso hook`: the Claude Code PostToolUse hook on Edit, MultiEdit, Write and
// NotebookEdit. It reads the hook's JSON on stdin, sends the edit into the
// agent's draft, and hands any news back to the agent as extra context.
//
// It never blocks the agent and never fails: on any error it logs to
// .avcs/hook.log, forgets the file's known copy (so the next `abso record`
// sends it whole), and exits 0.
//
// Before sending an Edit, it replays the edit on the known copy. Only when the
// replay gives exactly the file on disk (both with `\n` line endings, as the
// server holds text) does it send the edit itself; otherwise (a file changed
// by a shell command, an edit the tool adjusted) it sends the whole file with
// `record`.

import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Api, type News, newsLines } from "./api.ts";
import { findRoot, isReader, readConfig } from "./config.ts";
import { editBody, newsContext, normalize, spellingText, uncomposedText } from "./core.ts";
import { fromEnv } from "./env-names.ts";
import { forgetKnown, isPaused, loadIgnore, logNews, readKnown, readText, relativeTo, writeKnown } from "./folder.ts";
import { tryFolderLock } from "./lock.ts";
import { readKnownModes } from "./modes.ts";
import { stateDir } from "./state-dir.ts";

/** The fields of Claude Code's PostToolUse input that the hook reads. */
interface HookInput {
	readonly session_id?: string;
	readonly cwd?: string;
	readonly tool_name?: string;
	readonly tool_input?: Record<string, unknown>;
	readonly agent_id?: string;
}

export interface HookResult {
	/** What to print on stdout: Claude Code's JSON, or nothing. */
	readonly stdout: string;
	/** What happened, for the log and for tests. */
	readonly outcome: string;
}

const DEFAULT_TIMEOUT_MS = 4000;

/** Where install-mod.ts puts the mod: Claude Code's skills folder, which every session loads. */
export function modDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
	return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills", "avcs");
}

export async function runHook(
	stdin: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HookResult> {
	const started = performance.now();
	let input: HookInput;
	try {
		input = JSON.parse(stdin) as HookInput;
	} catch {
		return { stdout: "", outcome: "skipped: stdin was not JSON" };
	}
	// With the abso mod installed, every Claude Code session on this machine sends
	// its edits in-process, so this hook stands down rather than send them twice.
	if (fromEnv(env, "HOOK_FORCE") !== "1" && existsSync(join(modDir(env), ".claude-plugin", "plugin.json"))) {
		return { stdout: "", outcome: "skipped: the abso mod sends edits" };
	}
	const tool = input.tool_name ?? "";
	const toolInput = input.tool_input ?? {};
	const rawPath = toolInput.file_path ?? toolInput.notebook_path;
	if (typeof rawPath !== "string" || rawPath === "")
		return { stdout: "", outcome: `skipped: ${tool} has no file path` };
	// An edit through a link changes the link's target: judge the file it reached.
	const path = realOrSame(isAbsolute(rawPath) ? rawPath : resolve(input.cwd ?? process.cwd(), rawPath));
	const root = findRoot(dirname(path));
	if (root === undefined) return { stdout: "", outcome: "skipped: not in an abso folder" };

	let rel: string | undefined;
	let outcome: string;
	let news: string[] = [];
	try {
		rel = relativeTo(root, path);
		if (isPaused(root)) {
			outcome = "skipped: recording is paused (abso resume)";
		} else if (isReader(root)) {
			outcome = "skipped: this folder is a reader";
		} else if (rel === undefined || loadIgnore(root)(rel, false)) {
			outcome = "skipped: ignored path";
		} else if (readKnownModes(root).get(rel)?.link != null) {
			outcome = "skipped: a link (a file standing in for one); abso record sends links";
		} else {
			const config = readConfig(root, env);
			const timeout = Number(fromEnv(env, "HOOK_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS;
			const api = new Api(config, timeout);
			const who = {
				...(input.session_id ? { session: input.session_id } : {}),
				...(input.agent_id ? { subagent: input.agent_id } : {}),
			};
			// Never waits: while another abso command changes the folder's records, the edit is left for the next record (#51).
			const unlock = tryFolderLock(root, "hook");
			if (unlock === undefined) {
				outcome = "skipped: another abso command is changing this folder; abso record sends it";
			} else {
				try {
					const sent = await send(api, root, rel, tool, toolInput, who);
					outcome = sent.outcome;
					news = newsLines(sent.news);
					logNews(root, news);
				} finally {
					unlock();
				}
			}
		}
	} catch (err) {
		outcome = `error: ${(err as Error).message}`;
		if (rel !== undefined) {
			try {
				forgetKnown(root, rel);
			} catch {
				// Nothing more to do; the log line below still says what failed.
			}
		}
	}
	log(
		root,
		`${new Date().toISOString()}\t${tool}\t${rel ?? path}\t${outcome}\t${Math.round(performance.now())}ms total, ${Math.round(performance.now() - started)}ms in hook`,
	);
	if (news.length === 0) return { stdout: "", outcome };
	const context = newsContext(news);
	if (context === undefined) return { stdout: "", outcome };
	return {
		stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } })}\n`,
		outcome,
	};
}

async function send(
	api: Api,
	root: string,
	rel: string,
	tool: string,
	toolInput: Record<string, unknown>,
	who: { session?: string; subagent?: string },
): Promise<{ outcome: string; news?: News }> {
	const raw = readText(join(root, ...rel.split("/")));
	if (raw === undefined) {
		// Deleted, or not text. `record` with null says it's gone; a binary file is left out entirely.
		return { outcome: "skipped: file is missing or not text; abso record catches up" };
	}
	const disk = normalize(raw);
	const known = readKnown(root, rel);
	const body = editBody(tool, toolInput, rel, known, disk, who);
	if (body !== undefined) {
		const answer = await api.edit(body);
		if (answer.ok) {
			remember(root, rel, disk);
			return {
				outcome: body.content !== undefined ? "sent write" : "sent edit",
				news: [
					...newsLines(answer.news),
					...(answer.spelling ?? []).map(spellingText),
					...(answer.uncomposed ?? []).map(uncomposedText),
				],
			};
		}
		if (answer.reason !== "out of step") throw new Error(`edit refused: ${answer.reason}`);
	}
	const answer = await api.record({ [rel]: disk }, who);
	if (!answer.ok) throw new Error(`record refused: ${answer.reason ?? "no reason given"}`);
	remember(root, rel, disk);
	return {
		outcome: body === undefined ? "sent whole file" : "out of step; sent whole file",
		news: [
			...newsLines(answer.news),
			...(answer.spelling ?? []).map(spellingText),
			...(answer.uncomposed ?? []).map(uncomposedText),
		],
	};
}

/** Keep the known copy in step. */
function remember(root: string, rel: string, text: string): void {
	writeKnown(root, rel, text);
}

function realOrSame(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function log(root: string, line: string): void {
	try {
		appendFileSync(join(stateDir(root), "hook.log"), `${line}\n`);
	} catch {
		// Logging is best effort.
	}
}
