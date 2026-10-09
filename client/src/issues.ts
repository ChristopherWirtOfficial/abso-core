// Issues (#54): avcs issues, avcs issue, avcs ask, avcs waiting and avcs
// answer. The Issues Worker keeps them (avcs-issues beside avcs, or
// AVCS_ISSUES_SERVER), and takes the same token. Statuses come from the work: a start note naming
// an issue (avcs start --issue N) puts it In progress, an open ask Blocked or
// In review, and publish --done closes it. Other agents' and people's words
// are quoted as JSON, so none can print as another line (#30).

import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Api, Ask, Attachment, Draft, DraftBody, IssuePage, IssueRow } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { type Config, readMachineServers, trustedServers } from "./config.ts";
import { issuesServerFor, tokenGoesTo } from "./core.ts";
import { seenText, shortWhen } from "./times.ts";

const q = (s: string): string => JSON.stringify(s);

/** The folder, with its Api pointed at the Issues Worker: the token goes only where tokenGoesTo allows, as for the avcs server. */
function openIssues(env: Env): { config: Config; api: Api } {
	const { config, api } = open(env);
	const server = env.env.AVCS_ISSUES_SERVER || issuesServerFor(config.server, readMachineServers(env.env));
	if (server === undefined)
		throw new UsageError(
			`${config.server} has no Issues Worker beside it that abso knows; ~/.avcs/servers.json or AVCS_ISSUES_SERVER names one`,
		);
	if (config.token !== undefined && !tokenGoesTo(server, trustedServers(env.env))) {
		throw new UsageError(
			`the Issues Worker is ${server}, and avcs sends your token only to its own servers and this machine. If ${server} is yours, name it in ~/.avcs/servers.json or AVCS_TRUSTED_SERVERS.`,
		);
	}
	api.issuesServer = server;
	return { config, api };
}

function issueNumber(word: string | undefined, what = "an issue number"): number {
	if (word === undefined || !/^#?\d+$/.test(word)) throw new UsageError(`${what} is a number, like 12`);
	return Number(word.replace("#", ""));
}

/** One issue as a line. */
export function issueLine(i: IssueRow): string {
	const detail = [
		i.agent !== null && !i.agents.includes(i.agent) ? `for ${i.agent}` : "",
		i.agents.length > 0 ? i.agents.join(", ") : "",
		i.blockedBy.length > 0 ? `blocked by ${i.blockedBy.join(", ")}` : "",
		(i.labels ?? []).length > 0 ? `labels ${i.labels.join(", ")}` : "",
		i.versions.length > 0 ? `${i.versions.length === 1 ? "version" : "versions"} ${i.versions.join(", ")}` : "",
		i.waitingOn.length > 0 ? `waiting on ${i.waitingOn.join(", ")}` : "",
		i.parent !== null ? `under ${i.parent}` : "",
		i.children > 0 ? plural(i.children, "sub-issue") : "",
		`updated ${shortWhen(i.updated)}`,
	].filter((d) => d !== "");
	return `  ${String(i.id).padStart(3)}  ${i.status.padEnd(11)}  ${q(i.title)}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`;
}

function askLine(a: Ask & { title?: string | null }): string {
	const what = a.review ? "a review" : a.kind === "task" ? "a task" : "a question";
	const where = a.issue === null ? "" : ` on issue ${a.issue}${a.title ? ` (${q(a.title)})` : ""}`;
	const extra = [
		// Who answered, and when, on the ask's own line, so a handled ask can't pass for an open one.
		a.answer
			? `${a.outcome === "withdrawn" ? "withdrawn" : "answered"} by ${a.answer.by}, ${shortWhen(a.answer.at)}`
			: "",
		!a.answer && a.seen !== undefined ? seenText(a.seen) : "",
		a.due ? `due ${a.due}` : "",
		a.blocks.length > 0 ? `blocks ${a.blocks.join(", ")}` : "",
	].filter((x) => x !== "");
	const head = `  ask ${a.id}: ${a.by}, ${shortWhen(a.at)}, asks ${a.of} ${what}${where}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}: ${q(a.question)}`;
	const lines = [head];
	if (a.options.length > 0) lines.push(`    options: ${a.options.map((o, i) => `${i + 1}. ${q(o)}`).join(", ")}`);
	if (a.recommendation) lines.push(`    ${a.recommendation.by} recommends: ${q(a.recommendation.text)}`);
	if (a.answer && a.outcome === "withdrawn") {
		if (a.answer.words !== "") lines.push(`    why: ${q(a.answer.words)}`);
	} else if (a.answer) lines.push(`    answer: ${q(a.answer.words)}`);
	return lines.join("\n");
}

/** One edit in an issue's activity: what changed, and who was told. */
function editLine(e: IssuePage["edits"][number]): string {
	const c = e.changes;
	const said = [
		c.title ? `title ${q(String(c.title.from))} to ${q(String(c.title.to))}` : "",
		c.description ? "the description" : "",
		c.parent ? (c.parent.to === null ? "no parent" : `parent issue ${String(c.parent.to)}`) : "",
		c.agent ? (c.agent.to === null ? "no Agent" : `Agent ${String(c.agent.to)}`) : "",
		c.blockedBy
			? (c.blockedBy.to as number[]).length === 0
				? "blocked by nothing"
				: `blocked by ${(c.blockedBy.to as number[]).join(", ")}`
			: "",
		c.labels
			? (c.labels.to as string[]).length === 0
				? "no labels"
				: `labels ${(c.labels.to as string[]).join(", ")}`
			: "",
	].filter((x) => x !== "");
	return `  ${e.by}, ${shortWhen(e.at)}: ${said.join("; ")} (${e.notified.length > 0 ? `told ${e.notified.join(", ")}` : "told nobody"})`;
}

/** Labels as typed, lower-cased, since the Worker refuses upper case (Security): --label Friction means friction. */
function labelList(value: string): string[] {
	return listOf(value).map((l) => l.toLowerCase());
}

/** A comma-separated list of names or issue numbers; "none" is the empty list. */
function listOf(value: string): string[] {
	return value.trim() === "none"
		? []
		: value
				.split(",")
				.map((v) => v.trim())
				.filter((v) => v !== "");
}

/** The most one attachment may be: the Issues Worker's cap, checked here before sending (abso issue 171). */
const ATTACH_MAX = 10 * 1024 * 1024;

/** Uploads each file --attach names (comma-separated), in order, and answers their ids. Nothing is sent if a file is missing or too big. */
async function uploadAttachments(api: Api, cwd: string, value: string | undefined): Promise<string[]> {
	if (value === undefined) return [];
	const paths = listOf(value);
	if (paths.length === 0) throw new UsageError("--attach names files, comma-separated: --attach shot.png,after.png");
	const files = paths.map((p) => {
		const full = resolve(cwd, p);
		let size: number;
		try {
			size = statSync(full).size;
		} catch {
			throw new UsageError(`--attach ${p}: no such file`);
		}
		if (size > ATTACH_MAX)
			throw new UsageError(`--attach ${p} is ${sizeText(size)}; one attachment is at most ${sizeText(ATTACH_MAX)}`);
		return { full, name: basename(full) };
	});
	const ids: string[] = [];
	for (const f of files) ids.push((await api.attachmentUpload(readFileSync(f.full), f.name)).id);
	return ids;
}

function sizeText(n: number): string {
	return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Attachments as lines under what carries them: name, size and where it's served. */
function attachmentLines(
	api: Pick<Api, "attachmentUrl"> | undefined,
	files: readonly Attachment[] | undefined,
	indent: string,
): string[] {
	return (files ?? []).map(
		(a) => `${indent}attached ${a.id}: ${q(a.name)}, ${sizeText(a.size)}${api ? `, ${api.attachmentUrl(a.id)}` : ""}`,
	);
}

/** An issue's page, as text. */
export function issuePage(p: IssuePage, api?: Pick<Api, "attachmentUrl">): string[] {
	const i = p.issue;
	const facts = [
		i.parent !== null ? `Under issue ${i.parent}.` : "",
		`Opened by ${i.opened.by}, ${shortWhen(i.opened.at)}.`,
		i.agent !== null ? `Agent: ${i.agent}.` : "",
		i.agents.length > 0 ? `Working on it: ${i.agents.join(", ")}.` : "",
		i.blockedBy.length > 0 ? `Blocked by: issue${i.blockedBy.length === 1 ? "" : "s"} ${i.blockedBy.join(", ")}.` : "",
		(i.labels ?? []).length > 0 ? `Labels: ${i.labels.join(", ")}.` : "",
		i.versions.length > 0 ? `Versions: ${i.versions.join(", ")}.` : "",
		i.waitingOn.length > 0 ? `Waiting on: ${i.waitingOn.join(", ")}.` : "",
		i.closed
			? `${i.closed.how === "done" ? "Done" : "Dropped"} by ${i.closed.by}${i.closed.version !== null ? ` in version ${i.closed.version}` : ""}, ${shortWhen(i.closed.at)}.`
			: "",
	].filter((f) => f !== "");
	return [
		`Issue ${i.id}: ${q(i.title)} [${i.status}]`,
		facts.join(" "),
		...(i.lines ? [`From ${i.lines.file} lines ${i.lines.from}-${i.lines.to} at version ${i.lines.version}.`] : []),
		...(i.description !== "" ? ["", ...i.description.split("\n").map((l) => `  ${l}`)] : []),
		...attachmentLines(api, i.attachments, "  "),
		...(p.asks.length > 0 ? ["", "Asks:", ...p.asks.map(askLine)] : []),
		...(p.comments.length > 0
			? [
					"",
					"Comments:",
					...p.comments.flatMap((c) => [
						`  ${c.by}${c.kind === "objection" ? " objects" : ""}, ${shortWhen(c.at)}: ${q(c.text)}`,
						...attachmentLines(api, c.attachments, "    "),
					]),
				]
			: []),
		...((p.edits ?? []).length > 0 ? ["", "Edits:", ...p.edits.map(editLine)] : []),
		...(p.children.length > 0 ? ["", "Sub-issues:", ...p.children.map(issueLine)] : []),
		...((i.watchers ?? []).length > 0 ? ["", `Watchers: ${i.watchers.join(", ")}.`] : []),
		"",
		`avcs start "..." --issue ${i.id} starts on it; avcs issue ${i.id} --comment "..." comments; avcs ask <who> "..." --issue ${i.id} asks.`,
	];
}

export async function runIssues(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 0)
		throw new UsageError(
			"issues takes no words: avcs issues [--open] [--status <s>] [--agent <a>] [--parent <N>] [--label <l,l>] | avcs issues --labels; avcs issue <N> shows one",
		);
	const { api } = openIssues(env);
	if (bool(args, "drafts")) {
		const { drafts } = await api.drafts();
		return {
			text:
				drafts.length === 0
					? 'No drafts. avcs issue draft "<title>" saves one: only you see it, and nobody hears of it.'
					: [
							`${plural(drafts.length, "draft")}, newest first (only you see them):`,
							...drafts.map(draftLine),
							"avcs issue draft <D> --open opens one as an issue; --delete deletes it.",
						].join("\n"),
			json: { drafts },
		};
	}
	if (bool(args, "labels")) {
		const { labels } = await api.issueLabels();
		return {
			text:
				labels.length === 0
					? 'No labels yet. avcs issue new "<title>" --label friction labels a new issue; avcs issue <N> --label <l> labels one.'
					: [
							`${plural(labels.length, "label")} in use:`,
							...labels.map((l) => `  ${l.label}: ${l.open} open of ${l.total}`),
							"avcs issues --label <label> lists a label's issues.",
						].join("\n"),
			json: { labels },
		};
	}
	const parent = str(args, "parent");
	const filter = {
		...(str(args, "status") ? { status: str(args, "status")! } : {}),
		...(str(args, "agent") ? { agent: str(args, "agent")! } : {}),
		...(parent !== undefined ? { parent: issueNumber(parent, "--parent") } : {}),
		...(str(args, "label") !== undefined ? { labels: labelList(str(args, "label")!) } : {}),
		open: bool(args, "open"),
	};
	const { issues } = await api.issues(filter);
	const scope = [
		filter.open ? "open " : "",
		filter.status ? `${filter.status} ` : "",
		filter.labels ? `${filter.labels.join(", ")} ` : "",
	].join("");
	return {
		text:
			issues.length === 0
				? `No ${scope}issues${filter.agent ? ` for ${filter.agent}` : ""}${parent !== undefined ? ` under ${parent}` : ""}. avcs issue new "<title>" opens one.`
				: [
						`${plural(issues.length, `${scope}issue`)}, most recently updated first:`,
						...issues.map(issueLine),
						"avcs issue <N> shows one.",
					].join("\n"),
		json: { issues },
	};
}

/** A new issue's fields from the command line, as open and drafts take them; `title` only when words were given. */
function openFields(args: Parsed, title: string): DraftBody {
	const lines = str(args, "lines");
	const at = lines === undefined ? undefined : /^(.+):(\d+)(?:-(\d+))?@(\d+)$/.exec(lines);
	if (lines !== undefined && !at)
		throw new UsageError("--lines is <file>:<from>-<to>@<version>, like src/a.ts:10-14@140");
	const parent = str(args, "parent");
	return {
		...(title !== "" ? { title } : {}),
		...(str(args, "description") ? { description: str(args, "description")! } : {}),
		...(parent !== undefined ? { parent: issueNumber(parent, "--parent") } : {}),
		...(at ? { lines: { file: at[1]!, from: Number(at[2]), to: Number(at[3] ?? at[2]), version: Number(at[4]) } } : {}),
		...(str(args, "agent") ? { agent: str(args, "agent")! } : {}),
		...(str(args, "blocked-by") !== undefined
			? { blockedBy: listOf(str(args, "blocked-by")!).map((b) => issueNumber(b, "--blocked-by")) }
			: {}),
		...(str(args, "notify") !== undefined ? { notify: listOf(str(args, "notify")!) } : {}),
		...(str(args, "label") !== undefined ? { labels: labelList(str(args, "label")!) } : {}),
	};
}

/** One draft as a line: its number, title, and what else it holds. */
function draftLine(d: Draft): string {
	const b = d.body;
	const more = [
		b.agent ? `for ${b.agent}` : "",
		b.parent ? `under ${b.parent}` : "",
		(b.labels ?? []).length > 0 ? `labels ${b.labels!.join(", ")}` : "",
		b.description ? "a description" : "",
	].filter((m) => m !== "");
	return `  draft ${d.id}: ${b.title ? q(b.title) : "(no title yet)"}${more.length > 0 ? ` (${more.join("; ")})` : ""}, saved ${shortWhen(d.saved)}`;
}

/**
 * Drafts (abso issue 3): an issue not opened yet, this agent's alone, with no
 * number and no news. `abso issue draft "<title>" [fields]` saves a new one;
 * `abso issue draft <D> [fields]` changes one; --open opens it as an issue;
 * --delete deletes it. `abso issues --drafts` lists them.
 */
async function runDraft(api: Api, args: Parsed, words: string[]): Promise<Output> {
	const [d, ...more] = words;
	if (d !== undefined && /^\d+$/.test(d) && more.length === 0) {
		const id = Number(d);
		if (bool(args, "delete") && bool(args, "open")) throw new UsageError("--open or --delete, not both");
		if (bool(args, "delete")) {
			await api.deleteDraft(id);
			return { text: `Deleted draft ${id}.`, json: { draft: id, deleted: true } };
		}
		if (bool(args, "open")) {
			const r = await api.openDraft(id, openFields(args, ""));
			return {
				text: `Opened draft ${id} as issue ${r.id}. avcs start "..." --issue ${r.id} starts on it.`,
				json: { draft: id, id: r.id },
			};
		}
		// Saving replaces the draft's body, so the fields given go over what it holds.
		const found = (await api.drafts()).drafts.find((x) => x.id === id);
		if (!found) throw new UsageError(`you have no draft ${id}; avcs issues --drafts lists yours`);
		await api.saveDraft({ ...found.body, ...openFields(args, ""), id });
		return { text: `Saved draft ${id}.`, json: { draft: id } };
	}
	if (bool(args, "open") || bool(args, "delete"))
		throw new UsageError("--open and --delete take a draft's number: avcs issue draft <D> --open");
	const r = await api.saveDraft(openFields(args, words.join(" ")));
	return {
		text: `Saved draft ${r.id}. Only you see it, and nobody hears of it. avcs issue draft ${r.id} --open opens it as an issue.`,
		json: { draft: r.id },
	};
}

export async function runIssue(args: Parsed, env: Env): Promise<Output> {
	const [first, ...rest] = args.positionals;
	const { api } = openIssues(env);
	if (first === "draft") return runDraft(api, args, rest);
	if (first === "new") {
		if (rest.length === 0)
			throw new UsageError(
				'avcs issue new "<title>" [--description "..."] [--parent <N>] [--lines <file>:<from>-<to>@<version>] [--agent <agent>] [--blocked-by <N,N>] [--notify <who,who>] [--label <l,l>]',
			);
		const fields = { ...openFields(args, rest.join(" ")), title: rest.join(" ") };
		const attachments = await uploadAttachments(api, env.cwd, str(args, "attach"));
		const r = await api.issueOpen({ ...fields, ...(attachments.length > 0 ? { attachments } : {}) });
		return {
			text: `Opened issue ${r.id}${attachments.length > 0 ? ` with ${plural(attachments.length, "attachment")} (${attachments.join(", ")})` : ""}. avcs start "..." --issue ${r.id} starts on it.`,
			json: { id: r.id, ...(attachments.length > 0 ? { attachments } : {}) },
		};
	}
	if (first === undefined || rest.length > 0)
		throw new UsageError(
			'avcs issue <N> [--comment "..." | --object "..." | --drop | --reopen | --done [--done-by <version>] | an edit], or avcs issue new "<title>"',
		);
	const id = issueNumber(first);
	const comment = str(args, "comment");
	const object = str(args, "object");
	const doneBy = str(args, "done-by");
	const markingDone = bool(args, "done") || doneBy !== undefined;
	const edits = ["title", "description", "parent", "agent", "blocked-by", "label", "unlabel"].filter(
		(f) => str(args, f) !== undefined,
	);
	if (
		[
			comment !== undefined,
			object !== undefined,
			bool(args, "drop"),
			bool(args, "reopen"),
			markingDone,
			edits.length > 0,
		].filter(Boolean).length > 1
	)
		throw new UsageError("one of --comment, --object, --drop, --reopen, --done or an edit at a time");
	if (edits.length > 0) {
		const parent = str(args, "parent");
		const agent = str(args, "agent");
		const blockedBy = str(args, "blocked-by");
		const r = await api.issueEdit(id, {
			...(str(args, "title") !== undefined ? { title: str(args, "title")! } : {}),
			...(str(args, "description") !== undefined ? { description: str(args, "description")! } : {}),
			...(parent !== undefined ? { parent: parent === "none" ? null : issueNumber(parent, "--parent") } : {}),
			...(agent !== undefined ? { agent: agent === "none" ? null : agent } : {}),
			...(blockedBy !== undefined ? { blockedBy: listOf(blockedBy).map((b) => issueNumber(b, "--blocked-by")) } : {}),
			...(bool(args, "quiet") ? { notify: false } : {}),
			...(str(args, "notify") !== undefined ? { also: listOf(str(args, "notify")!) } : {}),
			...(str(args, "label") !== undefined ? { addLabels: labelList(str(args, "label")!) } : {}),
			...(str(args, "unlabel") !== undefined ? { removeLabels: labelList(str(args, "unlabel")!) } : {}),
			// A labels-only edit tells nobody unless --notify names people.
			...(edits.every((f) => f === "label" || f === "unlabel") && str(args, "notify") !== undefined
				? { notify: true }
				: {}),
		});
		return {
			text: `Edited issue ${id}. ${r.notified.length > 0 ? `Told ${r.notified.join(", ")}.` : "Told nobody."}`,
			json: { issue: id, edit: r.edit, notified: r.notified },
		};
	}
	if (bool(args, "quiet") || str(args, "notify") !== undefined)
		throw new UsageError(
			"--quiet and --notify go with an edit (--title, --description, --parent, --agent, --blocked-by, --label or --unlabel)",
		);
	if (str(args, "attach") !== undefined && comment === undefined && object === undefined)
		throw new UsageError("--attach goes with avcs issue new or --comment (or --object)");
	if (comment !== undefined || object !== undefined) {
		const attachments = await uploadAttachments(api, env.cwd, str(args, "attach"));
		const r = await api.issueComment(id, (comment ?? object)!, object !== undefined, attachments);
		return {
			text: `${object !== undefined ? "Objected" : "Commented"} on issue ${id}${attachments.length > 0 ? ` with ${plural(attachments.length, "attachment")} (${attachments.join(", ")})` : ""}. Its agents hear it.`,
			json: { id: r.id, issue: id, ...(attachments.length > 0 ? { attachments } : {}) },
		};
	}
	if (bool(args, "drop")) {
		await api.issueDrop(id);
		return { text: `Dropped issue ${id}.`, json: { issue: id, dropped: true } };
	}
	if (bool(args, "reopen")) {
		await api.issueReopen(id);
		return { text: `Reopened issue ${id}.`, json: { issue: id, reopened: true } };
	}
	if (markingDone) {
		let version: number | null = null;
		if (doneBy !== undefined) {
			version = issueNumber(doneBy, "--done-by");
			if (version < 1) throw new UsageError("--done-by is a published version, 1 or more");
			try {
				await api.show(version, { draft: null });
			} catch {
				throw new UsageError(`no version ${version}`);
			}
		}
		await api.issueDone(id, version);
		return {
			text: version === null ? `Marked issue ${id} done.` : `Marked issue ${id} done in version ${version}.`,
			json: { issue: id, done: true, ...(version !== null ? { version } : {}) },
		};
	}
	const page = await api.issue(id);
	return { text: issuePage(page, api).join("\n"), json: { ...page } };
}

export async function runAsk(args: Parsed, env: Env): Promise<Output> {
	const withdraw = str(args, "withdraw");
	if (withdraw !== undefined) return withdrawAsk(args, env, withdraw);
	if (str(args, "note") !== undefined)
		throw new UsageError('--note goes with --withdraw: avcs ask --withdraw <ask> --note "why"');
	const [of, ...words] = args.positionals;
	if (of === undefined || words.length === 0)
		throw new UsageError(
			'avcs ask <who> "<question>" [--issue <N>] [--review | --task] [--due <YYYY-MM-DD>] [--blocks <N,N>] [--options "A|B|C"]; who is an agent, or person:<id>',
		);
	const { api } = openIssues(env);
	if (bool(args, "review") && bool(args, "task")) throw new UsageError("an ask is a review or a task, not both");
	const issue = str(args, "issue");
	const blocks = str(args, "blocks");
	const options = str(args, "options");
	const r = await api.ask({
		of,
		question: words.join(" "),
		...(issue !== undefined ? { issue: issueNumber(issue, "--issue") } : {}),
		...(bool(args, "review") ? { review: true } : {}),
		...(bool(args, "task") ? { kind: "task" as const } : {}),
		...(str(args, "due") ? { due: str(args, "due")! } : {}),
		...(blocks !== undefined ? { blocks: blocks.split(",").map((b) => issueNumber(b.trim(), "--blocks")) } : {}),
		...(options !== undefined
			? {
					options: options
						.split("|")
						.map((o) => o.trim())
						.filter((o) => o !== ""),
				}
			: {}),
	});
	return { text: `Asked ${of} (ask ${r.id}). They hear it; avcs waiting shows what's open.`, json: { id: r.id } };
}

/** avcs ask --withdraw <ask> [--note "why"]: the asker takes an ask back. It closes like an answer, and the one asked hears it. */
async function withdrawAsk(args: Parsed, env: Env, word: string): Promise<Output> {
	const others = ["issue", "due", "blocks", "options"].filter((f) => str(args, f) !== undefined);
	if (args.positionals.length > 0 || others.length > 0 || bool(args, "review") || bool(args, "task"))
		throw new UsageError('avcs ask --withdraw <ask> [--note "why"] takes nothing else: it takes back an ask you made');
	const id = issueNumber(word, "the ask number");
	const { api } = openIssues(env);
	const note = str(args, "note");
	const r = await api.withdraw(id, note !== undefined ? { note } : {});
	return { text: `Withdrew ask ${id}. ${r.ask.of} hears it, and it no longer waits on them.`, json: { ask: r.ask } };
}

export async function runWaiting(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 0)
		throw new UsageError("waiting takes no words: avcs waiting [--of <agent or person:id>] [--mine]");
	const { api, config } = openIssues(env);
	const mine = bool(args, "mine") || str(args, "of") === config.agent;
	const of = mine ? config.agent : str(args, "of");
	const { asks } = mine ? await api.waitingMine() : await api.waiting(of);
	return {
		text:
			asks.length === 0
				? `Nothing is waiting${of ? ` on ${of}` : ""}.`
				: [
						`${plural(asks.length, "open ask")}${of ? ` of ${of}` : ""}, soonest due first:`,
						...asks.map(askLine),
						'avcs answer <ask> "..." answers one asked of you.',
					].join("\n"),
		json: { asks },
	};
}

export async function runAnswer(args: Parsed, env: Env): Promise<Output> {
	const [first, ...words] = args.positionals;
	const id = issueNumber(first, "the ask number");
	const option = str(args, "option");
	const done = bool(args, "done");
	if (words.length === 0 && option === undefined && !done)
		throw new UsageError('avcs answer <ask> "<words>" | --option <N> [--note "..."] | --done [--note "..."]');
	const { api } = openIssues(env);
	const note = str(args, "note");
	const r = await api.answer(id, {
		...(words.length > 0 ? { words: words.join(" ") } : {}),
		...(option !== undefined ? { option: /^\d+$/.test(option) ? Number(option) - 1 : option } : {}),
		...(done ? { done: true } : {}),
		...(note !== undefined ? { note } : {}),
	});
	return { text: `Answered ask ${id}. ${r.ask.by} hears it.`, json: { ask: r.ask } };
}
