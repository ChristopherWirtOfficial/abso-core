// What every abso command shares: its output, its environment, the folder it opens, and the news it took.

import { Api, type News, newsLines, type RunKind } from "./api.ts";
import { UsageError } from "./args.ts";
import { type Config, findRoot, readConfig } from "./config.ts";
import { newsBlockLines, newsShown } from "./core.ts";
import { logNews } from "./folder.ts";

export const EXIT = { ok: 0, error: 1, refused: 2 } as const;

export interface Output {
	readonly text: string;
	readonly json: Record<string, unknown>;
	readonly exit?: number;
}

export interface Env {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where `run` streams the box's output as it arrives. */
	readonly write: (text: string) => void;
	/** Where `run` streams the box's stderr; `write` when not given. */
	readonly writeErr?: (text: string) => void;
	/** What a box run is for, when a command runs one for its own ends (shot, bisect, publish --check). */
	readonly runKind?: RunKind;
	/** What a -file flag of - reads: stdin, unless a test gives it. */
	readonly readStdin?: () => string;
	/**
	 * The server --server named, checked (server-choice.ts), when the command was given one. It is used as given,
	 * so no environment setting redirects it (ABSO_ISSUES_SERVER included).
	 */
	readonly server?: string;
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function open(env: Env): { root: string; config: Config; api: Api } {
	const root = findRoot(env.cwd);
	if (root === undefined)
		throw new UsageError(
			`You're not in an abso folder: ${env.cwd} has no .abso/config.json, nor does any folder above it. abso join <project> makes one, or abso init a new project.`,
		);
	const config = readConfig(root, env.env);
	return { root, config, api: new Api(config) };
}

/**
 * News a command took from the server while recording first. main() prints it
 * after whatever the command says, so every command that takes news shows it
 * (#37, News Report: sync, run and diff took it, wrote it to .avcs/news.log and
 * printed nothing; 94 of the game's 613 items, 54 of them announcements).
 */
const takenNews: string[] = [];
export function takeNews(): string[] {
	return takenNews.splice(0);
}

/** News a record answered with: kept in .avcs/news.log, and printed by main(). */
export function heard(root: string, news: News | undefined): void {
	const lines = newsLines(news);
	logNews(root, lines);
	takenNews.push(...lines);
}

export function newsText(news: News): string[] {
	const lines = newsLines(news);
	return newsBlockLines(lines.map((n) => newsShown(n)));
}
