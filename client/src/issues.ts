// Issues (#54): abso issues, abso issue, abso ask, abso waiting and avcs
// answer. The Issues Worker keeps them (avcs-issues beside avcs, or
// ABSO_ISSUES_SERVER), and takes the same token. Statuses come from the work: a start note naming
// an issue (abso start --issue N) puts it In progress, an open ask Blocked or
// In review, and publish --done closes it. Other agents' and people's words
// are quoted as JSON, so none can print as another line (#30).

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	type Api,
	ApiError,
	type Ask,
	type Attachment,
	type CopyAnswer,
	type CopyBody,
	type Draft,
	type DraftBody,
	type IssuePage,
	type IssueRow,
	type IssueSearchHit,
} from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open, plural } from "./commands.ts";
import { type Config, readMachineServers, trustedServers } from "./config.ts";
import { issuesServerFor, tokenGoesTo } from "./core.ts";
import { fromEnv } from "./env-names.ts";
import { ignoredHere } from "./fetch.ts";
import { loadIgnore, relativeTo } from "./folder.ts";
import { queuedLines, standing } from "./queue.ts";
import { seenText, shortWhen } from "./times.ts";

const q = (s: string): string => JSON.stringify(s);

/** The folder, with its Api pointed at the Issues Worker: the token goes only where tokenGoesTo allows, as for the avcs server. */
function openIssues(env: Env): { root: string; config: Config; api: Api } {
	const { root, config, api } = open(env);
	const server = fromEnv(env.env, "ISSUES_SERVER") || issuesServerFor(config.server, readMachineServers(env.env));
	if (server === undefined)
		throw new UsageError(
			`${config.server} has no Issues Worker beside it that abso knows; ~/.abso/servers.json or ABSO_ISSUES_SERVER names one`,
		);
	if (config.token !== undefined && !tokenGoesTo(server, trustedServers(env.env))) {
		throw new UsageError(
			`the Issues Worker is ${server}, and abso sends your token only to its own servers and this machine. If ${server} is yours, name it in ~/.abso/servers.json or ABSO_TRUSTED_SERVERS.`,
		);
	}
	api.issuesServer = server;
	return { root, config, api };
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

function askLine(a: Ask & { title?: string | null }, api?: Pick<Api, "attachmentUrl">): string {
	const what = a.review ? "a review" : a.kind === "task" ? "a task" : "a question";
	const where = a.issue === null ? "" : ` on issue ${a.issue}${a.title ? ` (${q(a.title)})` : ""}`;
	const extra = [
		// Who answered, and when, on the ask's own line, so a handled ask can't pass for an open one.
		a.answer
			? `${a.outcome === "withdrawn" ? "withdrawn" : "answered"} by ${a.answer.by}, ${shortWhen(a.answer.at)}`
			: "",
		!a.answer && a.ack ? `acknowledged ${shortWhen(a.ack.at)}, not answered yet` : "",
		!a.answer && !a.ack && a.seen !== undefined ? seenText(a.seen) : "",
		a.due ? `due ${a.due}` : "",
		a.blocks.length > 0 ? `blocks ${a.blocks.join(", ")}` : "",
	].filter((x) => x !== "");
	const head = `  ask ${a.id}: ${a.by}, ${shortWhen(a.at)}, asks ${a.of} ${what}${where}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}: ${q(a.question)}`;
	const lines = [head, ...attachmentLines(api, a.attachments, "    ")];
	if (a.options.length > 0) lines.push(`    options: ${a.options.map((o, i) => `${i + 1}. ${q(o)}`).join(", ")}`);
	if (a.recommendation) lines.push(`    ${a.recommendation.by} recommends: ${q(a.recommendation.text)}`);
	if (!a.answer && a.ack && a.ack.note !== "") lines.push(`    ${a.of} acknowledged: ${q(a.ack.note)}`);
	if (a.answer && a.outcome === "withdrawn") {
		if (a.answer.words !== "") lines.push(`    why: ${q(a.answer.words)}`);
	} else if (a.answer)
		lines.push(`    answer: ${q(a.answer.words)}`, ...attachmentLines(api, a.answer.attachments, "      "));
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

/** Labels as typed, lower-cased, since the Worker refuses upper case: --label Friction means friction. */
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

/** " with 2 attachments (a…, a…)" after a write that carried some; nothing otherwise. */
function withFiles(ids: readonly string[]): string {
	return ids.length > 0 ? ` with ${plural(ids.length, "attachment")} (${ids.join(", ")})` : "";
}

/**
 * What to say when a write sent files the server didn't keep: an Issues server from before asks carried
 * attachments takes the words and leaves the files out. Nothing to say when it kept them, or none were sent.
 */
function notKept(sent: readonly string[], kept: readonly string[] | undefined, what: string): string | undefined {
	if (sent.length === 0 || (kept !== undefined && sent.every((id) => kept.includes(id)))) return undefined;
	return `The Issues server didn't keep the ${sent.length === 1 ? "file" : "files"} on ${what}: it is older than this client. The words went; the ${sent.length === 1 ? "file goes" : "files go"} on a comment instead (abso issue <N> --comment "..." --attach ...).`;
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
	return (files ?? []).flatMap((a) => [
		`${indent}attached ${a.id}: ${q(a.name)}, ${sizeText(a.size)}${api ? `, ${api.attachmentUrl(a.id)}` : ""}`,
		// An SVG is shown as the PNG drawn from it; its own file is a download beside it.
		...(a.source
			? [
					`${indent}  drawn from ${q(a.source.name)}, ${sizeText(a.source.size)}${api ? `, ${api.attachmentUrl(a.id)}/source` : ""}`,
				]
			: []),
	]);
}

/** A saved attachment's file name: its id, then its own name with anything but letters, digits, . - _ made _. */
export function savedName(id: string, name: string): string {
	const own = (name.split(/[\\/]/).pop() ?? "")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+/, "_")
		.slice(0, 100);
	return `${id}-${own || "file"}`;
}

/**
 * abso issue N --save-attachments <folder>: every attachment on the issue, its
 * comments and its asks and answers, written to that folder as <id>-<name>; an svg's own file
 * beside the png drawn from it. Not into the abso folder unless abso leaves
 * that place out, or the images would be recorded as edits.
 */
async function saveAttachments(api: Api, root: string, cwd: string, dir: string, page: IssuePage): Promise<Output> {
	const target = resolve(cwd, dir);
	const inside = target === resolve(root) ? "" : relativeTo(root, target);
	if (inside !== undefined && (inside === "" || !ignoredHere(loadIgnore(root), inside, true)))
		throw new UsageError(
			`${dir} is inside this abso folder, so abso would record the images as your edits. Save them outside the folder, or into a folder .absoignore leaves out`,
		);
	const seen = new Set<string>();
	const all = [
		...(page.issue.attachments ?? []),
		...page.comments.flatMap((c) => c.attachments ?? []),
		...page.asks.flatMap((a) => [...(a.attachments ?? []), ...(a.answer?.attachments ?? [])]),
	].filter((a) => !seen.has(a.id) && seen.add(a.id));
	if (all.length === 0)
		return {
			text: `Issue ${page.issue.id} has no attachments.`,
			json: { issue: page.issue.id, folder: target, files: [] },
		};
	mkdirSync(target, { recursive: true });
	const files: { id: string; path: string; size: number }[] = [];
	for (const a of all) {
		const wanted = [{ name: a.name, source: false }, ...(a.source ? [{ name: a.source.name, source: true }] : [])];
		for (const w of wanted) {
			const bytes = await api.attachmentBytes(a.id, w.source, ATTACH_MAX);
			const path = join(target, savedName(a.id, w.name));
			writeFileSync(path, bytes);
			files.push({ id: a.id, path, size: bytes.length });
		}
	}
	return {
		text: [
			`Saved ${plural(files.length, "file")} from issue ${page.issue.id} to ${target}:`,
			...files.map((f) => `  ${basename(f.path)}, ${sizeText(f.size)}`),
		].join("\n"),
		json: { issue: page.issue.id, folder: target, files },
	};
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
	// The links below open for people signed in on the website; an agent's fetch of one is refused. Say the way in
	// before the first link, so an agent reads the files instead of hunting for them.
	const files =
		(i.attachments ?? []).length +
		p.comments.reduce((n, c) => n + (c.attachments ?? []).length, 0) +
		p.asks.reduce((n, a) => n + (a.attachments ?? []).length + (a.answer?.attachments ?? []).length, 0);
	return [
		`Issue ${i.id}: ${q(i.title)} [${i.status}]`,
		facts.join(" "),
		...(files > 0
			? [
					`${files === 1 ? "1 file is" : `${files} files are`} attached below. To read ${files === 1 ? "it" : "them"}: abso issue ${i.id} --save-attachments <folder> saves ${files === 1 ? "it" : "every one"} there, then open the files. The links are for people signed in on the website.`,
				]
			: []),
		...(i.lines ? [`From ${i.lines.file} lines ${i.lines.from}-${i.lines.to} at version ${i.lines.version}.`] : []),
		...(i.description !== "" ? ["", ...i.description.split("\n").map((l) => `  ${l}`)] : []),
		...attachmentLines(api, i.attachments, "  "),
		...(p.asks.length > 0 ? ["", "Asks:", ...p.asks.map((a) => askLine(a, api))] : []),
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
		`abso start "..." --issue ${i.id} starts on it; abso issue ${i.id} --comment "..." comments; abso ask <who> "..." --issue ${i.id} asks.`,
	];
}

export async function runIssues(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 0)
		throw new UsageError(
			"issues takes no words: abso issues [--open] [--status <s>] [--agent <a>] [--parent <N>] [--label <l,l>] | abso issues --labels; abso issue <N> shows one",
		);
	const { api } = openIssues(env);
	if (bool(args, "drafts")) {
		const { drafts } = await api.drafts();
		return {
			text:
				drafts.length === 0
					? 'No drafts. abso issue draft "<title>" saves one: only you see it, and nobody hears of it.'
					: [
							`${plural(drafts.length, "draft")}, newest first (only you see them):`,
							...drafts.map(draftLine),
							"abso issue draft <D> --open opens one as an issue; --delete deletes it.",
						].join("\n"),
			json: { drafts },
		};
	}
	if (bool(args, "labels")) {
		const { labels } = await api.issueLabels();
		return {
			text:
				labels.length === 0
					? 'No labels yet. abso issue new "<title>" --label friction labels a new issue; abso issue <N> --label <l> labels one.'
					: [
							`${plural(labels.length, "label")} in use:`,
							...labels.map((l) => `  ${l.label}: ${l.open} open of ${l.total}`),
							"abso issues --label <label> lists a label's issues.",
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
				? `No ${scope}issues${filter.agent ? ` for ${filter.agent}` : ""}${parent !== undefined ? ` under ${parent}` : ""}. abso issue new "<title>" opens one.`
				: [
						`${plural(issues.length, `${scope}issue`)}, most recently updated first:`,
						...issues.map(issueLine),
						"abso issue <N> shows one.",
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
				text: `Opened draft ${id} as issue ${r.id}. abso start "..." --issue ${r.id} starts on it.`,
				json: { draft: id, id: r.id },
			};
		}
		// Saving replaces the draft's body, so the fields given go over what it holds.
		const found = (await api.drafts()).drafts.find((x) => x.id === id);
		if (!found) throw new UsageError(`you have no draft ${id}; abso issues --drafts lists yours`);
		await api.saveDraft({ ...found.body, ...openFields(args, ""), id });
		return { text: `Saved draft ${id}.`, json: { draft: id } };
	}
	if (bool(args, "open") || bool(args, "delete"))
		throw new UsageError("--open and --delete take a draft's number: abso issue draft <D> --open");
	const r = await api.saveDraft(openFields(args, words.join(" ")));
	return {
		text: `Saved draft ${r.id}. Only you see it, and nobody hears of it. abso issue draft ${r.id} --open opens it as an issue.`,
		json: { draft: r.id },
	};
}

/** The flags --copy-to goes with: anything else on the same command is refused, so a copy is never half an edit. */
const COPY_FLAGS = new Set(["copy-to", "clean", "dry-run"]);

/** abso issue <N> --copy-to <project>: the server reads the issue and writes the copy. */
async function runCopy(api: Api, id: number, to: string, args: Parsed, env: Env): Promise<Output> {
	const other = [...args.flags.keys()].filter((f) => !COPY_FLAGS.has(f) && f !== "json");
	if (other.length > 0)
		throw new UsageError(`--copy-to goes alone (with --clean and --dry-run), not with --${other[0]}`);
	if (to === api.config.project)
		throw new UsageError(`issue ${id} is already in ${to}; --copy-to names another project`);
	const clean = str(args, "clean");
	const texts = clean === undefined ? {} : readClean(resolve(env.cwd, clean), clean);
	const dryRun = bool(args, "dry-run");
	const from = api.config.project;
	let answer: CopyAnswer;
	try {
		answer = await api.issueCopy(to, { ...texts, from, issue: id, ...(dryRun ? { dryRun: true } : {}) });
	} catch (e) {
		if (e instanceof ApiError && e.status === 403 && !dryRun)
			throw new ApiError(`${e.message}. --dry-run still shows what would go.`, e.status);
		throw e;
	}
	if ("dryRun" in answer) {
		const p = answer.plan;
		const edited = (list: { edited: boolean }[]) => list.filter((x) => x.edited).length;
		const lines = [
			`A dry run: nothing was written. Copying ${from} issue ${id} into ${to} would make:`,
			`  ${q(p.title)}${p.closed ? `, ${p.closed.how}` : ""}${p.edited.length > 0 ? ` (${p.edited.join(" and ")} edited when copied)` : ""}`,
			`  ${plural(p.comments.length, "comment")}${edited(p.comments) > 0 ? ` (${edited(p.comments)} edited)` : ""}, ${plural(p.asks.length, "answered ask")}${edited(p.asks) > 0 ? ` (${edited(p.asks)} edited)` : ""}${p.labels.length > 0 ? `, labelled ${p.labels.join(", ")}` : ""}`,
			...skippedLines(p.skipped),
			`Run it again without --dry-run to copy it.`,
		];
		return { text: lines.join("\n"), json: answer };
	}
	return {
		text: [
			`Copied ${from} issue ${id} to ${to} issue ${answer.id}. Its comments and asks keep their authors and times, and issue ${id} has a comment saying where it went.`,
			...skippedLines(answer.skipped),
		].join("\n"),
		json: answer,
	};
}

function skippedLines(skipped: { comments: number[]; asks: number[] }): string[] {
	const parts = [
		...(skipped.comments.length > 0 ? [`comments ${skipped.comments.join(", ")}`] : []),
		...(skipped.asks.length > 0 ? [`asks ${skipped.asks.join(", ")}`] : []),
	];
	return parts.length > 0 ? [`  not copied: ${parts.join("; ")} (open asks, and what --clean left out)`] : [];
}

/** --clean's file: cleaned texts by source id. The server checks each id against the issue it reads. */
function readClean(path: string, given: string): Omit<CopyBody, "from" | "issue"> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new UsageError(
			`--clean ${given}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "not JSON"}`,
		);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new UsageError(`--clean ${given}: a JSON object with title, description, comments or asks`);
	const known = new Set(["title", "description", "comments", "asks"]);
	const unknown = Object.keys(raw).filter((k) => !known.has(k));
	if (unknown.length > 0)
		throw new UsageError(`--clean ${given}: ${unknown[0]} isn't one of title, description, comments, asks`);
	return raw as Omit<CopyBody, "from" | "issue">;
}

export async function runIssue(args: Parsed, env: Env): Promise<Output> {
	const [first, ...rest] = args.positionals;
	const { root, api } = openIssues(env);
	const saveTo = str(args, "save-attachments");
	if (saveTo !== undefined) {
		const other = [...args.flags.keys()].filter((f) => f !== "save-attachments" && f !== "json");
		if (other.length > 0 || first === "new" || first === "draft")
			throw new UsageError(
				`--save-attachments goes alone with an issue number: abso issue <N> --save-attachments <folder>${other.length > 0 ? `, not with --${other[0]}` : ""}`,
			);
	}
	if (first === "draft") return runDraft(api, args, rest);
	if (first === "new") {
		if (rest.length === 0)
			throw new UsageError(
				'abso issue new "<title>" [--description "..."] [--parent <N>] [--lines <file>:<from>-<to>@<version>] [--agent <agent>] [--blocked-by <N,N>] [--notify <who,who>] [--label <l,l>]',
			);
		const fields = { ...openFields(args, rest.join(" ")), title: rest.join(" ") };
		const attachments = await uploadAttachments(api, env.cwd, str(args, "attach"));
		const r = await api.issueOpen({ ...fields, ...(attachments.length > 0 ? { attachments } : {}) });
		return {
			text: `Opened issue ${r.id}${attachments.length > 0 ? ` with ${plural(attachments.length, "attachment")} (${attachments.join(", ")})` : ""}. abso start "..." --issue ${r.id} starts on it.`,
			json: { id: r.id, ...(attachments.length > 0 ? { attachments } : {}) },
		};
	}
	if (first === undefined || rest.length > 0)
		throw new UsageError(
			'abso issue <N> [--comment "..." | --object "..." | --drop | --reopen | --done [--done-by <version>] | an edit], or abso issue new "<title>"',
		);
	const id = issueNumber(first);
	const copyTo = str(args, "copy-to");
	if (copyTo !== undefined) return runCopy(api, id, copyTo, args, env);
	if (str(args, "clean") !== undefined || bool(args, "dry-run"))
		throw new UsageError("--clean and --dry-run go with --copy-to <project>");
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
		throw new UsageError("--attach goes with abso issue new or --comment (or --object)");
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
	if (saveTo !== undefined) return saveAttachments(api, root, env.cwd, saveTo, page);
	return { text: issuePage(page, api).join("\n"), json: { ...page } };
}

export async function runAsk(args: Parsed, env: Env): Promise<Output> {
	const withdraw = str(args, "withdraw");
	if (withdraw !== undefined) return withdrawAsk(args, env, withdraw);
	if (str(args, "note") !== undefined)
		throw new UsageError('--note goes with --withdraw: abso ask --withdraw <ask> --note "why"');
	const [of, ...words] = args.positionals;
	if (of === undefined || words.length === 0)
		throw new UsageError(
			'abso ask <who> "<question>" [--issue <N>] [--review | --task] [--due <YYYY-MM-DD>] [--blocks <N,N>] [--options "A|B|C"]; who is an agent, or person:<id>',
		);
	const { api } = openIssues(env);
	if (bool(args, "review") && bool(args, "task")) throw new UsageError("an ask is a review or a task, not both");
	const issue = str(args, "issue");
	const blocks = str(args, "blocks");
	const options = str(args, "options");
	const attachments = await uploadAttachments(api, env.cwd, str(args, "attach"));
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
		...(attachments.length > 0 ? { attachments } : {}),
	});
	const lost = notKept(attachments, r.attachments, `ask ${r.id}`);
	return {
		text: `Asked ${of} (ask ${r.id})${withFiles(attachments)}. They hear it; abso waiting shows what's open.${lost ? ` ${lost}` : ""}`,
		json: { id: r.id, ...(attachments.length > 0 ? { attachments } : {}), ...(lost ? { notKept: lost } : {}) },
	};
}

/** abso ask --withdraw <ask> [--note "why"]: the asker takes an ask back. It closes like an answer, and the one asked hears it. */
async function withdrawAsk(args: Parsed, env: Env, word: string): Promise<Output> {
	const others = ["issue", "due", "blocks", "options", "attach"].filter((f) => str(args, f) !== undefined);
	if (args.positionals.length > 0 || others.length > 0 || bool(args, "review") || bool(args, "task"))
		throw new UsageError('abso ask --withdraw <ask> [--note "why"] takes nothing else: it takes back an ask you made');
	const id = issueNumber(word, "the ask number");
	const { api } = openIssues(env);
	const note = str(args, "note");
	const r = await api.withdraw(id, note !== undefined ? { note } : {});
	return { text: `Withdrew ask ${id}. ${r.ask.of} hears it, and it no longer waits on them.`, json: { ask: r.ask } };
}

/** One search hit as two lines: the issue, then where it matched and the words around it. */
export function searchLines(h: IssueSearchHit): string[] {
	const where = h.meaning ? "by meaning" : h.where === "comment" ? `in comment ${h.comment}` : `in the ${h.where}`;
	const words = h.snippet
		.replace(/[\u0001\u0002]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [
		`  ${String(h.issue.id).padStart(3)}  ${h.issue.status.padEnd(11)}  ${q(h.issue.title)}`,
		`       ${where}${words && words !== h.issue.title ? `: ${q(words)}` : ""}`,
	];
}

export async function runSearch(args: Parsed, env: Env): Promise<Output> {
	const words = args.positionals.join(" ").trim();
	if (words === "") throw new UsageError('search needs words: abso search "<words>" [--limit <N>]');
	const limitWord = str(args, "limit");
	const limit = limitWord === undefined ? undefined : Number(limitWord);
	if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 50))
		throw new UsageError("--limit is a number from 1 to 50");
	const { api } = openIssues(env);
	const { hits } = await api.issueSearch(words, limit);
	return {
		text:
			hits.length === 0
				? `Nothing matches ${q(words)}.`
				: [
						`${plural(hits.length, "issue")} for ${q(words)}, best first:`,
						...hits.flatMap(searchLines),
						"abso issue <N> shows one.",
					].join("\n"),
		json: { hits },
	};
}

export async function runWaiting(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 0)
		throw new UsageError("waiting takes no words: abso waiting [--of <agent or person:id>] [--mine]");
	const { api, config } = openIssues(env);
	const mine = bool(args, "mine") || str(args, "of") === config.agent;
	const of = mine ? config.agent : str(args, "of");
	// With --mine, your own publishes still in the merge queue are open work too. A server without a queue,
	// or one that can't be read now, leaves them out rather than failing the asks.
	const [{ asks }, queue] = await Promise.all([
		mine ? api.waitingMine() : api.waiting(of),
		mine ? api.queueState().catch(() => undefined) : undefined,
	]);
	const queued = queuedLines(queue, config.agent);
	const yours = (queue?.items ?? []).filter((q) => q.agent === config.agent);
	return {
		text: [
			...queued,
			...(asks.length === 0
				? [queued.length > 0 ? `No open asks of ${of}.` : `Nothing is waiting${of ? ` on ${of}` : ""}.`]
				: [
						`${plural(asks.length, "open ask")}${of ? ` of ${of}` : ""}, soonest due first:`,
						...asks.map((a) => askLine(a, api)),
						'abso answer <ask> "..." answers one asked of you.',
					]),
		].join("\n"),
		json: {
			asks,
			...(yours.length > 0
				? { queued: yours.map((q) => ({ id: q.id, message: q.message, standing: standing(queue!.items, q.id) })) }
				: {}),
		},
	};
}

/** abso ack <ask> ["note"]: tell the asker you have it, and answer later. The ask stays open until abso answer. */
export async function runAck(args: Parsed, env: Env): Promise<Output> {
	const [first, ...words] = args.positionals;
	const id = issueNumber(first, "the ask number");
	const { api } = openIssues(env);
	const note = words.join(" ");
	const r = await api.ack(id, note !== "" ? { note } : {});
	return {
		text: `Acknowledged ask ${id}. ${r.ask.by} hears it; the ask stays open until abso answer ${id} "...".`,
		json: { ask: r.ask },
	};
}

export async function runAnswer(args: Parsed, env: Env): Promise<Output> {
	const [first, ...words] = args.positionals;
	const id = issueNumber(first, "the ask number");
	const option = str(args, "option");
	const done = bool(args, "done");
	if (words.length === 0 && option === undefined && !done)
		throw new UsageError('abso answer <ask> "<words>" | --option <N> [--note "..."] | --done [--note "..."]');
	const { api } = openIssues(env);
	const note = str(args, "note");
	const attachments = await uploadAttachments(api, env.cwd, str(args, "attach"));
	const r = await api.answer(id, {
		...(words.length > 0 ? { words: words.join(" ") } : {}),
		...(option !== undefined ? { option: /^\d+$/.test(option) ? Number(option) - 1 : option } : {}),
		...(done ? { done: true } : {}),
		...(note !== undefined ? { note } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
	});
	const lost = notKept(
		attachments,
		r.ask.answer?.attachments?.map((a) => a.id),
		`your answer to ask ${id}`,
	);
	return {
		text: `Answered ask ${id}${withFiles(attachments)}. ${r.ask.by} hears it.${lost ? ` ${lost}` : ""}`,
		json: { ask: r.ask, ...(lost ? { notKept: lost } : {}) },
	};
}
