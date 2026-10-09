// abso announce and abso news: a message to the project's other agents,
// delivered once as news on each one's next edit (or the mod's next poll),
// and the news waiting for this agent.

import { newsLines } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { logNews } from "./folder.ts";
import { newsWithTime } from "./times.ts";

export async function runAnnounce(args: Parsed, env: Env): Promise<Output> {
	const text = args.positionals.join(" ").trim();
	if (text === "") throw new UsageError('say what to announce: abso announce [--to a,b] "text"');
	const rawTo = str(args, "to");
	const to =
		rawTo === undefined
			? undefined
			: rawTo
					.split(",")
					.map((a) => a.trim())
					.filter((a) => a !== "");
	if (to !== undefined && to.length === 0) throw new UsageError("--to names the agents, separated by commas");
	const { api } = open(env);
	const answer = await api.announce(text, to);
	const who = answer.to.length === 0 ? "nobody (no other agents yet)" : answer.to.join(", ");
	return {
		text: `Announced to ${who}. Each gets it once, as news on their next edit, or within about 30 seconds where the abso mod runs.`,
		json: { id: answer.id, to: answer.to },
	};
}

/** abso start: say what you are starting on, before any edit lands (#37, #13). */
export async function runStart(args: Parsed, env: Env): Promise<Output> {
	const { api } = open(env);
	if (bool(args, "done")) {
		await api.starting(null);
		return { text: "Starting note taken back.", json: { starting: null, overlaps: [] } };
	}
	const text = args.positionals[0]?.trim() ?? "";
	if (text === "") throw new UsageError('say what you are starting on: abso start "<what>" [files...]');
	const files = args.positionals.slice(1);
	// --issue N (#54): the issue this work is for; publish --done closes it.
	const issueFlag = args.flags.get("issue");
	const issue = typeof issueFlag === "string" ? Number(issueFlag) : undefined;
	if (issue !== undefined && (!Number.isInteger(issue) || issue < 1))
		throw new UsageError('--issue takes an issue number: abso start "<what>" --issue 12');
	const answer = await api.starting(text, files, issue !== undefined ? { issue } : {});
	const lines = [
		`Starting on "${text}"${files.length > 0 ? `, naming ${files.join(", ")}` : ""}${issue !== undefined ? ` for issue ${issue}` : ""}. abso where shows it to everyone until you publish (or abso start --done).` +
			(issue !== undefined ? ` abso publish --done closes issue ${issue}.` : ""),
	];
	if (answer.overlaps.length > 0) {
		lines.push("Already there:");
		for (const o of answer.overlaps) {
			const what = [
				o.changes ? plural(o.changes, "unpublished change") : "",
				o.starting ? `starting on "${o.starting}"` : "",
			]
				.filter((w) => w !== "")
				.join(", ");
			lines.push(`  ${o.file}: ${o.agent}${what === "" ? "" : ` (${what})`}`);
		}
		// The sentence people act on names who, and their note (#37, Builder 5 had to run abso where to learn it).
		const agents = [...new Set(answer.overlaps.map((o) => o.agent))];
		const notes = agents.flatMap((a) => {
			const note = answer.overlaps.find((o) => o.agent === a && o.starting)?.starting;
			return note === undefined ? [] : [`${a}'s "${note}"`];
		});
		lines.push(
			`${agents.join(" and ")} ${agents.length === 1 ? "hears" : "hear"} of your note on their next edit. If it is the same work${notes.length > 0 ? ` as ${notes.join(" or ")}` : ""}, settle who does what first: abso announce --to ${agents.join(",")} "..." reaches ${agents.length === 1 ? "them" : "each of them"}.`,
		);
	}
	return { text: lines.join("\n"), json: { ...answer } };
}

export async function runNews(_args: Parsed, env: Env): Promise<Output> {
	const { root, api } = open(env);
	const answer = await api.news();
	const news = newsLines(answer.news);
	logNews(root, news);
	if (news.length === 0) return { text: "No news.", json: { news } };
	const at = new Map((answer.items ?? []).map((i) => [i.text, i.at]));
	const items = news.map((text) => ({ text, at: at.get(text) ?? null }));
	return {
		text: [`${plural(news.length, "news item")}:`, ...items.map((i) => `  ${newsWithTime(i.text, i.at)}`)].join("\n"),
		json: { news, items, delivered: Date.now() },
	};
}
