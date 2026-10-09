// Review (#44): review is reading what
// landed. abso review lists the changes since you last looked, or shows one;
// abso note leaves a note on lines, which follows them as the file changes;
// abso notes lists them. The server holds changes and notes (Engine, 15a3035).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeAnswer, NoteAnswer } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { type Env, type Output, open, plural, recordFolder } from "./commands.ts";
import { fromEnv } from "./env-names.ts";
import { writeFileAtomic } from "./folder.ts";
import { fileArg, when } from "./history.ts";
import { stateDir } from "./state-dir.ts";

/** Where this folder last looked: a log position, kept in .avcs/review.json. */
const MARK = "review.json";

function readMark(root: string): number | undefined {
	try {
		const n = (JSON.parse(readFileSync(join(stateDir(root), MARK), "utf8")) as { since?: unknown }).since;
		return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

function writeMark(root: string, since: number): void {
	writeFileAtomic(join(stateDir(root), MARK), `${JSON.stringify({ since })}\n`);
}

const SAID = { comment: "says", objection: "objects", read: "read it" } as const;

function lines(n: NoteAnswer): string {
	if (n.lines === null) return `${n.file} (its lines are gone)`;
	return `${n.file} ${n.lines[0] === n.lines[1] ? `line ${n.lines[0]}` : `lines ${n.lines[0]}-${n.lines[1]}`}`;
}

/** One note as a line; replies are indented under their note. */
export function noteText(n: NoteAnswer): string {
	const state = n.state === "open" ? "" : ` [${n.state}]`;
	// Another agent's words, quoted as JSON so a quote or a line break in them can't print as another note (#30).
	if (n.reply !== null) return `    note ${n.id}, ${n.agent} replies: ${JSON.stringify(n.text)}${state}`;
	return `  note ${n.id}: ${n.agent} ${SAID[n.kind]} on ${lines(n)}${n.kind === "read" ? "" : `: ${JSON.stringify(n.text)}`}${state}`;
}

/** Notes with their replies under them, oldest thread first. */
function threads(notes: readonly NoteAnswer[]): string[] {
	// A reply whose note isn't in the list (closed, or filtered out) stands on its own.
	const ids = new Set(notes.map((n) => n.id));
	const top = notes.filter((n) => n.reply === null || !ids.has(n.reply));
	return top.flatMap((t) => [
		noteText(t),
		...(t.reply === null ? notes.filter((r) => r.reply === t.id).map(noteText) : []),
	]);
}

function versionsText(c: ChangeAnswer): string {
	const v = c.versions.map((x) => (x.draft === null ? `${x.version}` : `${x.draft}@${x.version}`));
	return v.length === 0 ? "no versions yet" : `${v.length === 1 ? "version" : "versions"} ${v.join(", ")}`;
}

/** One change in a list. */
/**
 * A change's title as a list shows it (#43, Git Lessons): the first line, cut
 * to 100 characters, as git log --oneline does, with an imported commit's
 * trailer (`git <sha12>, <author>, <time>`) as a short hash beside it. The
 * change page keeps the whole message.
 */
export function titleLine(title: string): string {
	const lines = title.trim().split("\n");
	const git = lines.length > 1 ? /^git ([0-9a-f]{7})[0-9a-f]*, /.exec(lines[lines.length - 1]!) : null;
	const first = lines[0]!.trim();
	return `${JSON.stringify(first.length > 100 ? `${first.slice(0, 97)}...` : first)}${git ? ` (git ${git[1]})` : ""}`;
}

function changeLine(c: ChangeAnswer): string {
	const open = (c.notes ?? []).filter((n) => n.kind === "objection" && n.state === "open").length;
	const files =
		c.files.length === 0
			? ""
			: `; ${plural(c.files.length, "file")}: ${c.files.slice(0, 4).join(", ")}${c.files.length > 4 ? ", ..." : ""}`;
	return `  ${c.id}  ${c.agent}, ${titleLine(c.title)}${c.open ? " (still going)" : ""}: ${versionsText(c)}${files}${open > 0 ? `; ${plural(open, "open objection")}` : ""}`;
}

/** The change page, as text. */
export function changePage(c: ChangeAnswer): string[] {
	const out = [
		`Change ${c.id} by ${c.agent}: ${JSON.stringify(c.title)}${c.open ? ` (still going: ${c.kind === "draft" ? "its draft has not landed" : "its start note lasts"})` : ""}.`,
		...(c.note
			? [
					`Set out to do: ${JSON.stringify(c.note.text)}${c.note.files.length > 0 ? `, naming ${c.note.files.join(", ")}` : ""}.`,
				]
			: []),
		`${versionsText(c)[0]!.toUpperCase()}${versionsText(c).slice(1)}:`,
		...c.versions.map(
			(v) =>
				`  ${v.draft === null ? "" : `${v.draft}@`}${v.version}, ${when(v.time)}: ${v.message}${v.files.length > 0 ? ` (${v.files.join(", ")})` : ""}`,
		),
		...(c.settled.length > 0
			? [
					`Settled: ${c.settled.map((s) => `${s.file} (kept ${s.kept}, against ${s.theirs.agent}'s version ${s.theirs.version})`).join("; ")}.`,
				]
			: []),
		...(c.refusals.length > 0
			? [
					`Refused ${plural(c.refusals.length, "time")} on the way: ${c.refusals.map((r) => `${r.kinds.join(", ")} (${r.files.join(", ")})`).join("; ")}.`,
				]
			: []),
		...((c.reviewers ?? []).length > 0
			? [
					`Reviewers: ${c.reviewers!.map((r) => `${r.agent} (${r.read ? "has read it" : "not yet"}; ${r.files.join(", ")})`).join("; ")}.`,
				]
			: []),
		...((c.notes ?? []).length > 0 ? ["Notes:", ...threads(c.notes!)] : ["No notes yet."]),
		`Each version's changes: abso show <version>. Leave a note: abso note <file>:<lines> "..." [--object].`,
	];
	return out;
}

/** A change named the way an agent thinks of it: its id, a version (v812), or an agent (its newest change). */
async function findChange(api: ReturnType<typeof open>["api"], word: string): Promise<ChangeAnswer> {
	if (/^\d+$/.test(word)) return api.change(Number(word));
	const v = /^v(\d+)$/i.exec(word);
	// show names a version's change (Engine, 6a2911b); older servers don't, and the recent changes are searched.
	if (v) {
		const shown = await api.show(Number(v[1]), { draft: null }).catch(() => undefined);
		if (shown?.change !== undefined) return api.change(shown.change);
	}
	const recent = (await api.changes(0, 200)).changes;
	const found = v
		? recent.find((c) => c.versions.some((x) => x.draft === null && x.version === Number(v[1])))
		: recent.find((c) => c.agent === word);
	if (!found)
		throw new UsageError(
			v
				? `no recent change holds version ${v[1]} of shared`
				: `no recent change by ${word}; abso review <id> takes a change id, v<version> or an agent`,
		);
	return api.change(found.id);
}

/** "2h", "30m", "1d": a span back from now, in ms; undefined for anything else. */
function span(raw: string): number | undefined {
	const m = /^(\d+)\s*(m|min|h|d)$/.exec(raw);
	return m
		? Number(m[1]) * { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "min" | "h" | "d"]
		: undefined;
}

export async function runReview(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1)
		throw new UsageError(
			"review takes at most one change: abso review [<id> | v<version> | <agent>] [--since <position|2h>]",
		);
	const { root, api } = open(env);
	const word = args.positionals[0];
	if (word !== undefined) {
		const c = await findChange(api, word);
		return { text: changePage(c).join("\n"), json: { ...c } };
	}
	// The list: since the mark (moved after listing), or --since without moving it.
	const raw = str(args, "since");
	const back = raw === undefined ? undefined : span(raw);
	if (raw !== undefined && back === undefined && !/^\d+$/.test(raw))
		throw new UsageError("--since takes a log position (4400) or a span back from now (30m, 2h, 1d)");
	const mark = readMark(root);
	const since = raw !== undefined && back === undefined ? Number(raw) : back !== undefined ? 0 : (mark ?? 0);
	const cutoff = back === undefined ? 0 : Date.now() - back;
	const lastActive = (c: ChangeAnswer): number => Math.max(c.time, ...c.versions.map((v) => v.time));
	// A first look shows the newest 20. Otherwise every change since the mark (or the span) is listed, page by
	// page, before the mark moves past them (AVCS - Git Lessons' review): one page would drop the older ones.
	const firstLook = mark === undefined && raw === undefined;
	// ABSO_REVIEW_PAGE shortens the page in tests.
	const pageSize = Number(fromEnv(process.env, "REVIEW_PAGE")) || 200;
	const answer = await api.changes(since, firstLook ? 20 : pageSize);
	const all = [...answer.changes];
	for (
		let older = answer.older;
		!firstLook && older !== undefined && (back === undefined || lastActive(all[all.length - 1]!) >= cutoff);
	) {
		const page = await api.changes(since, pageSize, older);
		all.push(...page.changes);
		older = page.older;
	}
	const list = back === undefined ? all : all.filter((c) => lastActive(c) >= cutoff);
	if (raw === undefined) writeMark(root, answer.next);
	const from =
		raw !== undefined ? `since ${raw}` : mark === undefined ? "lately (your first look)" : "since you last looked";
	return {
		text: [
			list.length === 0 ? `No changes ${from}.` : `${plural(list.length, "change")} ${from}, newest first:`,
			...list.map(changeLine),
			...(list.length > 0
				? ["abso review <id> shows one: what it set out to do, its versions, what it settled, its notes."]
				: []),
			...(raw === undefined ? ["abso review --since 2h looks further back."] : []),
		].join("\n"),
		json: { since, next: answer.next, changes: list },
	};
}

/** file:12 or file:12-30; not a Windows drive letter (C:...). */
const LINES = /^(.+?):(\d+)(?:-(\d+))?$/;

export async function runNote(args: Parsed, env: Env): Promise<Output> {
	const { root, config, api } = open(env);
	const reply = str(args, "reply");
	const close = str(args, "close");
	if (close !== undefined) {
		if (!/^\d+$/.test(close)) throw new UsageError("--close takes a note id: abso note --close 77 --resolved");
		const resolved = bool(args, "resolved");
		if (resolved === bool(args, "withdrawn"))
			throw new UsageError("say how it closes: abso note --close <id> --resolved, or --withdrawn");
		await api.noteClose(Number(close), resolved ? "resolved" : "withdrawn");
		return {
			text: `Note ${close} is ${resolved ? "resolved" : "withdrawn"}.`,
			json: { id: Number(close), how: resolved ? "resolved" : "withdrawn" },
		};
	}
	if (reply !== undefined) {
		if (!/^\d+$/.test(reply)) throw new UsageError('--reply takes a note id: abso note --reply 77 "fixed in v815"');
		const text = args.positionals.join(" ").trim();
		if (text === "") throw new UsageError('say what you reply: abso note --reply <id> "..."');
		const a = await api.note({ reply: Number(reply), text });
		return {
			text: `Replied to note ${reply} (reply ${a.id}); its writer and the thread hear it as news.`,
			json: { ...a },
		};
	}
	const where = args.positionals[0];
	const m = where === undefined ? null : LINES.exec(where);
	if (!m || /^[A-Za-z]$/.test(m[1]!))
		throw new UsageError(
			'note takes lines and text: abso note <file>:<line>[-<line>] "..." [--object], or --reply <id>, or --close <id>',
		);
	const text = args.positionals.slice(1).join(" ").trim();
	const read = bool(args, "read");
	if (text === "" && !read) throw new UsageError('say what the note says: abso note <file>:<lines> "..."');
	const from = Number(m[2]);
	const to = Number(m[3] ?? m[2]);
	if (to < from) throw new UsageError(`${where}: the range runs backwards`);
	const file = fileArg(root, env.cwd, m[1]!);
	const at = str(args, "at");
	const of = str(args, "draft");
	if (at !== undefined && !/^\d+$/.test(at)) throw new UsageError("--at takes a version of shared");
	if (at !== undefined && of !== undefined) throw new UsageError("--at and --draft both say which lines; give one");
	// The numbers mean the lines as this folder shows them: record it, then note them as this agent's own
	// draft shows them, unless --at (a version of shared) or --draft <agent> (their unpublished work) says otherwise.
	if (at === undefined && of === undefined && !config.reader) await recordFolder(root, api);
	const kind = bool(args, "object") ? "objection" : read ? "read" : "comment";
	const a = await api.note({
		file,
		from,
		to,
		text: text === "" ? "read" : text,
		kind,
		...(at !== undefined ? { version: Number(at) } : { of: of ?? config.agent }),
	});
	const said = kind === "objection" ? "Objection" : kind === "read" ? "Read mark" : "Note";
	return {
		text: `${said} ${a.id} on ${file} ${from === to ? `line ${from}` : `lines ${from}-${to}`}${a.change === null ? "" : ` (change ${a.change})`}. ${kind === "read" ? "Nobody is told." : "The lines' authors and the change's agent hear it as news; it follows the lines as the file changes."}`,
		json: { ...a, kind },
	};
}

export async function runNotes(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1)
		throw new UsageError("notes takes at most one file: abso notes [file] [--change <id>] [--all]");
	const { root, api } = open(env);
	const typed = args.positionals[0];
	const file = typed === undefined ? undefined : fileArg(root, env.cwd, typed);
	const change = str(args, "change");
	if (change !== undefined && !/^\d+$/.test(change)) throw new UsageError("--change takes a change id");
	const all = bool(args, "all");
	const { notes } = await api.notes({
		...(file ? { file } : {}),
		...(change ? { change: Number(change) } : {}),
		open: !all,
	});
	const scope = [file ? ` on ${file}` : "", change ? ` in change ${change}` : ""].join("");
	return {
		text:
			notes.length === 0
				? `No ${all ? "" : "open "}notes${scope}.`
				: [
						`${plural(notes.length, all ? "note" : "open note")}${scope}:`,
						...threads(notes),
						'abso note --reply <id> "..." answers one; abso note --close <id> --resolved closes yours.',
					].join("\n"),
		json: { notes },
	};
}
