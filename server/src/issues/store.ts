// Issues for the open server (abso-core issue 17): one store per project, in SQLite, holding current state:
// issues, comments, labels, asks with their answers and threads, claims, the versions out for each issue,
// drafts, and what each reader's news has shown. Ported from the platform's issues Worker, without its
// workflow and release stores, prose authorship records, attachments, copies and meaning search.
//
// Status comes from the work and nobody sets it: Done when a publish closed it (or someone marked it done),
// Blocked while an ask that isn't a review is open on it (or names it in `blocks`) or an issue it is blocked
// by is not done, In review while a review ask is open on it, In progress while a start note names it, and
// Open otherwise. An answer is kept in its writer's own words on the ask it answers.
//
// Watchers: who opened an issue, its Agent and any agent that claims it, its reviewer, whoever was named in
// Notify, and whoever comments. An edit tells them unless its writer says not to.

import type {
	Actor,
	Ask,
	AskReply,
	Comment,
	Draft,
	DraftBody,
	Edit,
	IssuePage,
	IssueRow,
	Lines,
	News,
	ProseAuthorship,
	Status,
} from "../../../client/src/issues-wire.ts";
import { unseenIn } from "../../../worker/project/unseen.ts";

export type {
	Actor,
	Ask,
	Claim,
	Comment,
	Draft,
	DraftBody,
	Edit,
	IssuePage,
	IssueRow,
	Lines,
	News,
	Status,
} from "../../../client/src/issues-wire.ts";

/** The SQL a Durable Object's storage gives (ctx.storage.sql), and node:sqlite in tests. */
export interface Sql {
	exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** A plain sentence for the person or agent; the route answers with it and `status`. */
export class IssuesError extends Error {
	readonly status: number;
	/** Seconds until a refused write may be tried again (429), for Retry-After. */
	readonly retryAfter: number | undefined;
	constructor(message: string, status = 400, retryAfter?: number) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/**
 * A label: 1-40 characters of lower-case letters, digits, and - _ . : (so
 * "friction", "good-first-issue", "area:client"). Anything else is refused,
 * upper case included, rather than changed: the client and the
 * site lower-case what's typed before sending.
 */
export const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;
export const LABELS_PER_ISSUE = 20;
/** Distinct labels a project may hold, since GET labels lists every one. */
export const LABELS_PER_PROJECT = 200;

/** Writes per writer (agent or person:<id>), since each can carry news. */
export const WRITES_PER_MINUTE = 100;
export const WRITES_PER_DAY = 1000;

/** At most this many @names in one comment are told. */
export const MENTIONS_MAX = 20;

/**
 * The agents a text names as @name, in order, each once: an @ at the start or after anything
 * but a name character, so an email address isn't one. A sentence's full stop or dash after the name isn't
 * part of it.
 */
export function mentionsIn(text: string): string[] {
	const names = new Set<string>();
	for (const m of text.matchAll(/(?:^|[^A-Za-z0-9._@-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) {
		names.add(m[1]!.replace(/[._-]+$/, ""));
		if (names.size === MENTIONS_MAX) break;
	}
	return [...names];
}

const LIMITS = {
	title: 200,
	description: 20_000,
	text: 4_000,
	open: 10_000,
	options: 10,
	blocks: 50,
	names: 50,
	drafts: 100,
	draft: 30_000,
};

/**
 * The tables the change count watches: what issue reads show. Not drafts (one person's), writes (the rate log),
 * search (kept from issues and comments) or meta. Fixed, since SCHEMA makes three triggers for each: a later
 * table appends its own three to SCHEMA instead.
 */
const COUNTED_TABLES = [
	"issues",
	"comments",
	"asks",
	"claims",
	"versions",
	"watchers",
	"blocked_by",
	"edits",
	"labels",
	"ask_replies",
] as const;

/**
 * The tables, as add-only migrations: the IssueProject object runs each once, in order (index.ts), so an
 * older Worker still reads a newer database. Append; never edit or reorder.
 */
export const SCHEMA: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY, parent INTEGER, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
		opened_by TEXT NOT NULL, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lines TEXT,
		closed_how TEXT, closed_by TEXT, closed_version INTEGER, closed_at INTEGER, agent TEXT)`,
	"CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, issue INTEGER NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)",
	`CREATE TABLE IF NOT EXISTS asks (id INTEGER PRIMARY KEY, issue INTEGER, by TEXT NOT NULL, of TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL,
		review INTEGER NOT NULL, due TEXT, recommendation TEXT, options TEXT NOT NULL, blocks TEXT NOT NULL, at INTEGER NOT NULL,
		answer_by TEXT, answer_words TEXT, answer_at INTEGER, seen_at INTEGER, outcome TEXT, ack_at INTEGER, ack_note TEXT, waiting_on TEXT)`,
	"CREATE TABLE IF NOT EXISTS claims (issue INTEGER NOT NULL, agent TEXT NOT NULL, change INTEGER NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (issue, agent))",
	"CREATE TABLE IF NOT EXISTS versions (issue INTEGER NOT NULL, version INTEGER NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (issue, version))",
	"CREATE TABLE IF NOT EXISTS watchers (issue INTEGER NOT NULL, who TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (issue, who))",
	"CREATE TABLE IF NOT EXISTS blocked_by (issue INTEGER NOT NULL, blocker INTEGER NOT NULL, PRIMARY KEY (issue, blocker))",
	"CREATE TABLE IF NOT EXISTS edits (id INTEGER PRIMARY KEY, issue INTEGER NOT NULL, by TEXT NOT NULL, changes TEXT NOT NULL, notified TEXT NOT NULL, at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL)",
	// Each writer's writes of the last day, for the limit.
	"CREATE TABLE IF NOT EXISTS writes (who TEXT NOT NULL, at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS labels (issue INTEGER NOT NULL, label TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (issue, label))",
	// Ask threads: replies from either side while the ask is open or after. An ask's waiting_on is null while it
	// waits on the one asked, and the asker's name after the one asked replies with a question.
	"CREATE TABLE IF NOT EXISTS ask_replies (id INTEGER PRIMARY KEY, ask INTEGER NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL, question INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)",
	// A reader's news: read up to when. Not counted, since no issue read shows it.
	"CREATE TABLE IF NOT EXISTS news_read (who TEXT PRIMARY KEY, at INTEGER NOT NULL)",
	"CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue)",
	"CREATE INDEX IF NOT EXISTS comments_at ON comments (at)",
	"CREATE INDEX IF NOT EXISTS asks_issue ON asks (issue)",
	"CREATE INDEX IF NOT EXISTS asks_open ON asks (answer_at)",
	"CREATE INDEX IF NOT EXISTS issues_parent ON issues (parent)",
	"CREATE INDEX IF NOT EXISTS issues_updated ON issues (updated_at)",
	"CREATE INDEX IF NOT EXISTS edits_issue ON edits (issue)",
	"CREATE INDEX IF NOT EXISTS drafts_owner ON drafts (owner)",
	"CREATE INDEX IF NOT EXISTS writes_who ON writes (who, at)",
	"CREATE INDEX IF NOT EXISTS labels_label ON labels (label)",
	"CREATE INDEX IF NOT EXISTS ask_replies_ask ON ask_replies (ask)",
	"CREATE INDEX IF NOT EXISTS ask_replies_at ON ask_replies (at)",
	// Search: every title, description and comment in a full-text index, kept in step by triggers.
	"CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(issue UNINDEXED, comment UNINDEXED, field UNINDEXED, text, tokenize = 'porter unicode61')",
	`CREATE TRIGGER IF NOT EXISTS search_issue_in AFTER INSERT ON issues BEGIN
		INSERT INTO search (issue, comment, field, text) VALUES (new.id, 0, 'title', new.title);
		INSERT INTO search (issue, comment, field, text) SELECT new.id, 0, 'description', new.description WHERE new.description <> '';
	END`,
	`CREATE TRIGGER IF NOT EXISTS search_issue_edit AFTER UPDATE OF title, description ON issues BEGIN
		DELETE FROM search WHERE issue = old.id AND comment = 0;
		INSERT INTO search (issue, comment, field, text) VALUES (new.id, 0, 'title', new.title);
		INSERT INTO search (issue, comment, field, text) SELECT new.id, 0, 'description', new.description WHERE new.description <> '';
	END`,
	"CREATE TRIGGER IF NOT EXISTS search_issue_out AFTER DELETE ON issues BEGIN DELETE FROM search WHERE issue = old.id; END",
	"CREATE TRIGGER IF NOT EXISTS search_comment_in AFTER INSERT ON comments BEGIN INSERT INTO search (issue, comment, field, text) VALUES (new.issue, new.id, 'comment', new.text); END",
	`CREATE TRIGGER IF NOT EXISTS search_comment_edit AFTER UPDATE OF text ON comments BEGIN
		DELETE FROM search WHERE comment = old.id;
		INSERT INTO search (issue, comment, field, text) VALUES (new.issue, new.id, 'comment', new.text);
	END`,
	"CREATE TRIGGER IF NOT EXISTS search_comment_out AFTER DELETE ON comments BEGIN DELETE FROM search WHERE comment = old.id; END",
	// The change count: one number that only grows, bumped by triggers on every table an issue read shows, so
	// every write path moves it, the seen marks waiting writes included. A reader can cache issue reads by it.
	"CREATE TABLE IF NOT EXISTS change_count (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)",
	"INSERT OR IGNORE INTO change_count (id, n) VALUES (1, 0)",
	...COUNTED_TABLES.flatMap((t) =>
		(["INSERT", "UPDATE", "DELETE"] as const).map(
			(op) =>
				`CREATE TRIGGER IF NOT EXISTS changed_${t}_${op.toLowerCase()} AFTER ${op} ON ${t} BEGIN UPDATE change_count SET n = n + 1 WHERE id = 1; END`,
		),
	),
];

/** How many news items one project gives a person's news, before the merge across projects. */
export const NEWS_MAX = 50;
/** How much of a comment, answer or reply a news item carries. */
const NEWS_TEXT_MAX = 280;

/**
 * One thing for a person's news: an answer to their ask, a reply on an ask they're in, an
 * @mention of them, or a comment, edit or close on an issue they watch, by someone else.
 */
export interface NewsItem {
	kind: "answer" | "reply" | "mention" | "comment" | "edit" | "closed";
	issue: number | null;
	title: string | null;
	ask?: number;
	by: string;
	text: string;
	at: number;
	read: boolean;
}

/** One issue a search found: where the best match is, a snippet around it, and how well it matched. */
export interface SearchHit {
	issue: { id: number; title: string; status: Status; updated: number; labels: string[] };
	/** Where the best match is: the title, the description, or a comment (with its id). */
	where: "title" | "description" | "comment";
	comment?: number;
	/** A few words around the match, with each matched span's [start, end) in `marks`. */
	snippet: string;
	marks: number[][];
	/** FTS5's bm25, made positive: higher matches better. */
	score: number;
}

/** A search hit as the client reads it: the issue's title and the matched text, each with who wrote it. */
export type AuthoredSearchHit = Omit<SearchHit, "issue"> & {
	issue: SearchHit["issue"] & { authorship: { title: ProseAuthorship } };
	matchedAuthorship: ProseAuthorship;
};

type StoredAskReply = Omit<AskReply, "authorship">;
type StoredAsk = Omit<Ask, "authorship" | "answer" | "ack" | "replies"> & {
	answer: { by: string; words: string; at: number } | null;
	ack?: { at: number; note: string };
	replies: StoredAskReply[];
};

const UNKNOWN: ProseAuthorship = { kind: "unknown", actor: null, provenance: "unknown", authorField: null };

/**
 * Who wrote a text, from the column that names its writer: an agent, or a person (person:<id>). This server
 * keeps no separate authorship records, so every text is its writer's own ("native").
 */
function authored(by: unknown, authorField: string): ProseAuthorship {
	if (typeof by !== "string" || by === "") return UNKNOWN;
	return { kind: by.startsWith("person:") ? "human" : "agent", actor: by, provenance: "native", authorField };
}

/**
 * A person's words as an FTS5 query: each word quoted, so nothing they type
 * is query syntax, and the last one a prefix, so a search box finds as they
 * type. Undefined when there's no word in it.
 */
export function searchQuery(q: string): string | undefined {
	const words = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12);
	if (!words || words.length === 0) return undefined;
	return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

type Row = Record<string, unknown>;

/** How an actor is named in the store and on the pages: the agent's name, or person:<id>. */
export function who(actor: Actor): string {
	return "agent" in actor ? actor.agent : `person:${actor.person}`;
}

/**
 * Words that reach agents on pages and in news: within `max`, with nothing a reader can't see (the engine's
 * own list, worker/project/unseen.ts), and on one line where `oneLine`.
 */
function text(value: unknown, what: string, max: number, required = true, oneLine = false): string {
	if (value === undefined || value === null || value === "") {
		if (required) throw new IssuesError(`${what} is missing`);
		return "";
	}
	if (typeof value !== "string") throw new IssuesError(`${what} is text`);
	const t = value.trim();
	if (required && t === "") throw new IssuesError(`${what} is empty`);
	if (t.length > max) throw new IssuesError(`${what} is ${t.length} characters; the most is ${max}`);
	const hidden = unseenIn(t);
	if (hidden !== null)
		throw new IssuesError(`${what} holds ${hidden}, which a reader of the page can't see; take it out`);
	if (oneLine && /[\n\t]/.test(t)) throw new IssuesError(`${what} is one line`);
	return t;
}

function issueNumber(value: unknown, what = "an issue number"): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new IssuesError(`${what} is a whole number from 1`);
	return n;
}

/** A list of names (agents, or person:<id>), each once. */
function names(value: unknown, what: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > LIMITS.names)
		throw new IssuesError(`${what} is a list of up to ${LIMITS.names} names`);
	return [...new Set(value.map((v, i) => text(v, `${what}'s name ${i + 1}`, 100, true, true)))];
}

/** Labels, checked as given (nothing is changed but surrounding spaces), each once, sorted. */
function labelsOf(value: unknown, what = "labels"): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > LABELS_PER_ISSUE)
		throw new IssuesError(`${what} is a list of up to ${LABELS_PER_ISSUE} labels`);
	const out = new Set<string>();
	for (const v of value) {
		const l = typeof v === "string" ? v.trim() : "";
		if (!LABEL.test(l))
			throw new IssuesError(
				`${JSON.stringify(v)} isn't a label: 1-40 lower-case letters, digits, and - _ . : (like friction or area:client)`,
			);
		out.add(l);
	}
	return [...out].sort();
}

/** A name, or null for none: "" and null clear it. */
function nameOrNone(value: unknown, what: string): string | null {
	return value === null || value === "" ? null : text(value, what, 100, true, true);
}

function lines(value: unknown): Lines | null {
	if (value === undefined || value === null) return null;
	const l = value as Partial<Lines>;
	if (
		typeof l.file !== "string" ||
		l.file === "" ||
		!Number.isInteger(l.from) ||
		!Number.isInteger(l.to) ||
		!Number.isInteger(l.version) ||
		l.from! < 1 ||
		l.to! < l.from! ||
		l.version! < 0
	) {
		throw new IssuesError("lines are {file, from, to, version}: lines from-to of a file at a version");
	}
	return { file: text(l.file, "the lines' file", 1000, true, true), from: l.from!, to: l.to!, version: l.version! };
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

export class IssuesStore {
	private readonly sql: Sql;
	private readonly now: () => number;
	private readonly atomic: (<T>(action: () => T) => T) | null;

	/** Over tables SCHEMA made (the object's migrations, or createTables in tests). `atomic` runs a transaction. */
	constructor(sql: Sql, now: () => number = Date.now, atomic?: <T>(action: () => T) => T) {
		this.sql = sql;
		this.now = now;
		this.atomic = atomic ?? null;
	}

	private transaction<T>(action: () => T): T {
		return this.atomic ? this.atomic(action) : action();
	}

	static createTables(sql: Sql): void {
		for (const s of SCHEMA) sql.exec(s);
	}

	/**
	 * The change count: it grows with every write an issue read can show and never goes back, so a read cached
	 * under it is never older than its key.
	 */
	changes(): number {
		return (this.rows("SELECT n FROM change_count WHERE id = 1")[0]?.n as number | undefined) ?? 0;
	}

	/**
	 * A reader's news here, newest first, at most NEWS_MAX: answers to their asks, replies on asks they asked or
	 * were asked, comments naming them as @name (`names`: what they go by; an agent goes by its own name), and on
	 * issues they watch, others' comments, the edits that told them, and closes. Each is read when it is at or
	 * before their news_read mark. `before` pages back.
	 */
	newsFor(reader: Actor, names: readonly string[], before?: number): NewsItem[] {
		const me = who(reader);
		const until = before ?? Number.MAX_SAFE_INTEGER;
		const mark = (this.rows("SELECT at FROM news_read WHERE who = ?", me)[0]?.at as number | undefined) ?? 0;
		const cut = (t: string) => (t.length > NEWS_TEXT_MAX ? `${t.slice(0, NEWS_TEXT_MAX - 1)}…` : t);
		const items: NewsItem[] = [];
		const add = (kind: NewsItem["kind"], r: Row, text: string, ask?: number) =>
			items.push({
				kind,
				issue: (r.issue as number | null) ?? null,
				title: (r.title as string | null) ?? null,
				...(ask !== undefined ? { ask } : {}),
				by: r.by as string,
				text: cut(text),
				at: r.at as number,
				read: (r.at as number) <= mark,
			});
		for (const r of this.rows(
			`SELECT a.id, a.issue, i.title, a.answer_by AS by, a.answer_words AS text, a.answer_at AS at FROM asks a
			LEFT JOIN issues i ON i.id = a.issue
			WHERE a.by = ? AND a.answer_at IS NOT NULL AND a.answer_at < ? AND a.answer_by <> ? AND (a.outcome IS NULL OR a.outcome <> 'withdrawn')
			ORDER BY a.answer_at DESC LIMIT ?`,
			me,
			until,
			me,
			NEWS_MAX,
		))
			add("answer", r, (r.text as string | null) ?? "", r.id as number);
		for (const r of this.rows(
			`SELECT r.ask, a.issue, i.title, r.by, r.text, r.at FROM ask_replies r JOIN asks a ON a.id = r.ask
			LEFT JOIN issues i ON i.id = a.issue
			WHERE (a.by = ? OR a.of = ?) AND r.by <> ? AND r.at < ? ORDER BY r.at DESC LIMIT ?`,
			me,
			me,
			me,
			until,
			NEWS_MAX,
		))
			add("reply", r, r.text as string, r.ask as number);
		const named = names.filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)).slice(0, 4);
		const mentioned = new Set<number>();
		for (const n of named)
			for (const r of this.rows(
				`SELECT c.id, c.issue, i.title, c.by, c.text, c.at FROM comments c JOIN issues i ON i.id = c.issue
				WHERE c.by <> ? AND c.at < ? AND instr(lower(c.text), ?) > 0 ORDER BY c.at DESC LIMIT ?`,
				me,
				until,
				`@${n.toLowerCase()}`,
				NEWS_MAX,
			)) {
				const said = mentionsIn(r.text as string).map((m) => m.toLowerCase());
				if (!said.includes(n.toLowerCase()) || mentioned.has(r.id as number)) continue;
				mentioned.add(r.id as number);
				add("mention", r, r.text as string);
			}
		for (const r of this.rows(
			`SELECT c.id, c.issue, i.title, c.by, c.text, c.at FROM comments c JOIN watchers w ON w.issue = c.issue AND w.who = ?
			JOIN issues i ON i.id = c.issue
			WHERE c.by <> ? AND c.at >= w.since AND c.at < ? ORDER BY c.at DESC LIMIT ?`,
			me,
			me,
			until,
			NEWS_MAX,
		))
			if (!mentioned.has(r.id as number)) add("comment", r, r.text as string);
		for (const r of this.rows(
			`SELECT e.issue, i.title, e.by, e.changes, e.at FROM edits e JOIN issues i ON i.id = e.issue
			WHERE e.by <> ? AND e.at < ? AND EXISTS (SELECT 1 FROM json_each(e.notified) WHERE value = ?)
			ORDER BY e.at DESC LIMIT ?`,
			me,
			until,
			me,
			NEWS_MAX,
		))
			add("edit", r, Object.keys(JSON.parse(r.changes as string) as object).join(", "));
		for (const r of this.rows(
			`SELECT i.id AS issue, i.title, i.closed_by AS by, i.closed_how, i.closed_at AS at FROM issues i
			JOIN watchers w ON w.issue = i.id AND w.who = ?
			WHERE i.closed_at IS NOT NULL AND i.closed_at < ? AND i.closed_by <> ? ORDER BY i.closed_at DESC LIMIT ?`,
			me,
			until,
			me,
			NEWS_MAX,
		))
			add("closed", r, r.closed_how as string);
		return items.sort((x, y) => y.at - x.at).slice(0, NEWS_MAX);
	}

	/** Marks the reader's news here read up to `at` (never back); answers the mark. */
	markNewsRead(reader: Actor, at: number): { read: number } {
		this.sql.exec(
			"INSERT INTO news_read (who, at) VALUES (?, ?) ON CONFLICT (who) DO UPDATE SET at = MAX(at, excluded.at)",
			who(reader),
			at,
		);
		return { read: this.rows("SELECT at FROM news_read WHERE who = ?", who(reader))[0]!.at as number };
	}

	private rows(query: string, ...b: unknown[]): Row[] {
		return this.sql.exec(query, ...b).toArray() as Row[];
	}

	private exists(id: number): Row {
		const row = this.rows("SELECT * FROM issues WHERE id = ?", issueNumber(id))[0];
		if (!row) throw new IssuesError(`there's no issue ${id}`, 404);
		return row;
	}

	private touch(...ids: (number | null)[]): void {
		const at = this.now();
		for (const id of ids)
			if (id !== null) this.sql.exec("UPDATE issues SET updated_at = MAX(updated_at, ?) WHERE id = ?", at, id);
	}

	/** Refuses labels that would take the project past LABELS_PER_PROJECT distinct ones. */
	private roomForLabels(labels: readonly string[]): void {
		const inUse = new Set(this.rows("SELECT DISTINCT label FROM labels").map((l) => l.label as string));
		const added = labels.filter((l) => !inUse.has(l));
		if (added.length > 0 && inUse.size + added.length > LABELS_PER_PROJECT)
			throw new IssuesError(
				`this project has ${inUse.size} labels, and ${LABELS_PER_PROJECT} is the most; use one it has (abso issues --labels lists them)`,
			);
	}

	/** Attachments aren't kept on this server: a write that names any is refused before anything is written. */
	private noAttachments(raw: unknown): void {
		if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return;
		throw new IssuesError("this server doesn't keep attachments; leave them off, or link the file instead", 501);
	}

	/** Adds watchers to an issue; each is kept once, from when they first watched. */
	private watch(id: number, ...people: (string | null | undefined)[]): void {
		const at = this.now();
		for (const p of people)
			if (p)
				this.sql.exec(
					"INSERT INTO watchers (issue, who, since) VALUES (?, ?, ?) ON CONFLICT (issue, who) DO NOTHING",
					id,
					p,
					at,
				);
	}

	private watchersOf(id: number): string[] {
		return this.rows("SELECT who FROM watchers WHERE issue = ? ORDER BY since, who", id).map((w) => w.who as string);
	}

	/** Blocked by, checked: issues that exist, not `id` itself, and none already waiting on `id` (that would wait forever). */
	private blockersFor(id: number | null, value: unknown): number[] {
		if (value === undefined || value === null) return [];
		if (!Array.isArray(value) || value.length > LIMITS.blocks)
			throw new IssuesError(`blocked by is a list of up to ${LIMITS.blocks} issue numbers`);
		const ids = [...new Set(value.map((b) => issueNumber(b, "an issue it's blocked by")))];
		for (const b of ids) {
			this.exists(b);
			if (b === id) throw new IssuesError(`issue ${id} can't be blocked by itself`);
			if (id !== null && this.waitsOn(b, id))
				throw new IssuesError(`issue ${b} already waits on issue ${id}, so neither could start`);
		}
		return ids;
	}

	/** Whether `from` waits on `on`, through Blocked by. */
	private waitsOn(from: number, on: number): boolean {
		const seen = new Set<number>();
		const next = [from];
		while (next.length > 0) {
			const at = next.pop()!;
			if (at === on) return true;
			if (seen.has(at)) continue;
			seen.add(at);
			for (const b of this.rows("SELECT blocker FROM blocked_by WHERE issue = ?", at)) next.push(b.blocker as number);
		}
		return false;
	}

	/** A parent, checked: an issue that exists and isn't `id` or under it. */
	private parentFor(id: number | null, value: unknown): number | null {
		if (value === undefined || value === null) return null;
		const parent = issueNumber(value, "the parent");
		this.exists(parent);
		for (
			let at: number | null = parent;
			at !== null;
			at = (this.rows("SELECT parent FROM issues WHERE id = ?", at)[0]?.parent as number | null | undefined) ?? null
		) {
			if (at === id) throw new IssuesError(`issue ${parent} is issue ${id} or under it, so it can't be its parent`);
		}
		return parent;
	}

	/** Every row's status and joins at once: one query per table, not one per issue. */
	private statuses(rows: Row[]): IssueRow[] {
		if (rows.length === 0) return [];
		// Open asks hold up their own issue and the ones they name in blocks.
		const held = new Map<number, { review: boolean; of: string }[]>();
		for (const a of this.rows(
			"SELECT issue, COALESCE(waiting_on, of) AS of, review, blocks FROM asks WHERE answer_at IS NULL",
		)) {
			const on = new Set<number>([
				...(a.issue !== null ? [a.issue as number] : []),
				...(JSON.parse(a.blocks as string) as number[]),
			]);
			for (const id of on)
				held.set(id, [...(held.get(id) ?? []), { review: a.review === 1 && id === a.issue, of: a.of as string }]);
		}
		const claims = new Map<number, string[]>();
		for (const c of this.rows("SELECT issue, agent FROM claims ORDER BY since"))
			claims.set(c.issue as number, [...(claims.get(c.issue as number) ?? []), c.agent as string]);
		const versions = new Map<number, number[]>();
		for (const v of this.rows("SELECT issue, version FROM versions ORDER BY version"))
			versions.set(v.issue as number, [...(versions.get(v.issue as number) ?? []), v.version as number]);
		const children = new Map<number, number>();
		for (const c of this.rows("SELECT parent, COUNT(*) AS n FROM issues WHERE parent IS NOT NULL GROUP BY parent"))
			children.set(c.parent as number, c.n as number);
		const labels = new Map<number, string[]>();
		for (const l of this.rows("SELECT issue, label FROM labels ORDER BY label"))
			labels.set(l.issue as number, [...(labels.get(l.issue as number) ?? []), l.label as string]);
		// Blocked by: each blocker, and whether it's Done yet.
		const blockers = new Map<number, { id: number; done: boolean }[]>();
		for (const b of this.rows(
			"SELECT blocked_by.issue, blocked_by.blocker, issues.closed_how FROM blocked_by LEFT JOIN issues ON issues.id = blocked_by.blocker ORDER BY blocked_by.blocker",
		)) {
			blockers.set(b.issue as number, [
				...(blockers.get(b.issue as number) ?? []),
				{ id: b.blocker as number, done: b.closed_how === "done" },
			]);
		}
		const retitled = this.lastEditors("title");
		return rows.map((r) => {
			const id = r.id as number;
			const asks = held.get(id) ?? [];
			const agents = claims.get(id) ?? [];
			const blockedBy = blockers.get(id) ?? [];
			const status: Status =
				r.closed_how === "done"
					? "done"
					: r.closed_how === "dropped"
						? "dropped"
						: asks.some((a) => !a.review) || blockedBy.some((b) => !b.done)
							? "blocked"
							: asks.length > 0
								? "in review"
								: agents.length > 0
									? "in progress"
									: "open";
			return {
				id,
				title: r.title as string,
				authorship: { title: this.issueFieldAuthorship(r, retitled) },
				parent: (r.parent as number | null) ?? null,
				status,
				agent: (r.agent as string | null | undefined) ?? null,
				agents,
				blockedBy: blockedBy.map((b) => b.id),
				labels: labels.get(id) ?? [],
				versions: versions.get(id) ?? [],
				waitingOn: r.closed_how ? [] : [...new Set(asks.map((a) => a.of))],
				opened: { by: r.opened_by as string, at: r.opened_at as number },
				updated: r.updated_at as number,
				closed: r.closed_how
					? {
							how: r.closed_how as "done" | "dropped",
							by: r.closed_by as string,
							version: (r.closed_version as number | null) ?? null,
							at: r.closed_at as number,
						}
					: null,
				children: children.get(id) ?? 0,
			};
		});
	}

	/** Who last edited `field` on each issue whose `field` was edited (or only issue `id`'s). */
	private lastEditors(field: "title" | "description", id?: number): Map<number, string> {
		const edited = new Map<number, string>();
		const where = `json_type(changes, '$.${field}') IS NOT NULL${id === undefined ? "" : " AND issue = ?"}`;
		for (const e of this.rows(
			`SELECT issue, by FROM edits WHERE ${where} ORDER BY id`,
			...(id === undefined ? [] : [id]),
		))
			edited.set(e.issue as number, e.by as string);
		return edited;
	}

	/** Who wrote an issue's title or description now: whoever last edited it, else whoever opened the issue. */
	private issueFieldAuthorship(row: Row, edited: Map<number, string>): ProseAuthorship {
		const editor = edited.get(row.id as number);
		return editor === undefined ? authored(row.opened_by, "issues.opened_by") : authored(editor, "edits.by");
	}

	/** An ask as the client reads it: each text with who wrote it. */
	private authoredAsk(a: StoredAsk): Ask {
		const { ack, ...ask } = a;
		return {
			...ask,
			authorship: { question: authored(a.by, "asks.by") },
			answer: a.answer ? { ...a.answer, authorship: authored(a.answer.by, "asks.answer_by") } : null,
			...(ack
				? { ack: { ...ack, authorship: { note: ack.note === "" ? UNKNOWN : authored(a.of, "ask_replies.by") } } }
				: {}),
			replies: a.replies.map((reply) => ({ ...reply, authorship: authored(reply.by, "ask_replies.by") })),
		};
	}

	// Reads ----------------------------------------------------------------------------------

	/**
	 * Issues, most recently updated first, filtered by status, agent, parent or
	 * labels (each one named). `open` leaves out done and dropped.
	 */
	list(
		filter: { status?: string; agent?: string; parent?: number; open?: boolean; labels?: readonly string[] } = {},
	): IssueRow[] {
		const wanted = filter.labels === undefined ? [] : labelsOf([...filter.labels], "the labels to filter by");
		const rows =
			filter.parent === undefined
				? this.rows("SELECT * FROM issues ORDER BY updated_at DESC, id DESC")
				: this.rows("SELECT * FROM issues WHERE parent = ? ORDER BY updated_at DESC, id DESC", filter.parent);
		return this.statuses(rows).filter(
			(i) =>
				(filter.status === undefined || i.status === filter.status) &&
				(filter.agent === undefined || i.agent === filter.agent || i.agents.includes(filter.agent)) &&
				(!filter.open || (i.status !== "done" && i.status !== "dropped")) &&
				wanted.every((l) => i.labels.includes(l)),
		);
	}

	/** Issues matching `q`, best first, one hit per issue at its best place. Drafts aren't searched. */
	search(q: string, limit = 20): AuthoredSearchHit[] {
		const query = searchQuery(q);
		if (query === undefined) return [];
		const rows = this.rows(
			"SELECT issue, comment, field, snippet(search, 3, char(1), char(2), '…', 14) AS snip, bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT 500",
			query,
		);
		const best = new Map<number, Row>();
		for (const r of rows) if (!best.has(r.issue as number)) best.set(r.issue as number, r);
		const ids = [...best.keys()].slice(0, Math.max(1, Math.min(limit, 50)));
		if (ids.length === 0) return [];
		const found = this.rows(`SELECT * FROM issues WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids);
		const rowOf = new Map(found.map((r) => [r.id as number, r]));
		const issues = new Map(this.statuses(found).map((i) => [i.id, i]));
		return ids.flatMap((id) => {
			const r = best.get(id)!;
			const i = issues.get(id);
			if (!i) return [];
			const { text, marks } = marked(r.snip as string);
			const where = r.field as SearchHit["where"];
			const commentId = r.comment as number;
			const matchedAuthorship =
				where === "comment"
					? authored(this.rows("SELECT by FROM comments WHERE id = ?", commentId)[0]?.by, "comments.by")
					: where === "title"
						? i.authorship.title
						: this.issueFieldAuthorship(rowOf.get(id)!, this.lastEditors("description", id));
			return [
				{
					issue: {
						id,
						title: i.title,
						status: i.status,
						updated: i.updated,
						labels: i.labels,
						authorship: i.authorship,
					},
					where,
					...(where === "comment" ? { comment: commentId } : {}),
					snippet: text,
					marks,
					matchedAuthorship,
					score: -(r.rank as number),
				},
			];
		});
	}

	/** Every label in use, with how many issues have it and how many of those are open (done and dropped aren't). */
	labelsInUse(): { label: string; open: number; total: number }[] {
		return this.rows(
			"SELECT label, COUNT(*) AS total, SUM(CASE WHEN issues.closed_how IS NULL THEN 1 ELSE 0 END) AS open FROM labels JOIN issues ON issues.id = labels.issue GROUP BY label ORDER BY label",
		).map((r) => ({ label: r.label as string, open: r.open as number, total: r.total as number }));
	}

	/** An ask with its thread, oldest first. */
	private withFiles(a: StoredAsk): StoredAsk {
		return { ...a, replies: this.repliesOf(a.id) };
	}

	/** An ask's replies, oldest first. */
	private repliesOf(ask: number): StoredAskReply[] {
		return this.rows("SELECT id, by, text, question, at FROM ask_replies WHERE ask = ? ORDER BY id", ask).map((r) => ({
			id: r.id as number,
			by: r.by as string,
			text: r.text as string,
			at: r.at as number,
			...(r.question === 1 ? { question: true as const } : {}),
		}));
	}

	page(id: number): IssuePage {
		const row = this.exists(id);
		const [issue] = this.statuses([row]);
		return {
			issue: {
				...issue!,
				description: row.description as string,
				authorship: {
					title: issue!.authorship.title,
					description: this.issueFieldAuthorship(row, this.lastEditors("description", id)),
				},
				lines: row.lines ? (JSON.parse(row.lines as string) as Lines) : null,
				watchers: this.watchersOf(id),
			},
			comments: this.rows("SELECT * FROM comments WHERE issue = ? ORDER BY id", id).map((c) => ({
				id: c.id as number,
				by: c.by as string,
				kind: c.kind as Comment["kind"],
				text: c.text as string,
				authorship: authored(c.by, "comments.by"),
				at: c.at as number,
			})),
			edits: this.rows("SELECT * FROM edits WHERE issue = ? ORDER BY id", id).map((e) => ({
				id: e.id as number,
				by: e.by as string,
				changes: JSON.parse(e.changes as string) as Edit["changes"],
				notified: JSON.parse(e.notified as string) as string[],
				at: e.at as number,
			})),
			asks: this.rows("SELECT * FROM asks WHERE issue = ? ORDER BY id", id).map((r) =>
				this.authoredAsk(this.withFiles(askOf(r))),
			),
			claims: this.rows("SELECT agent, change, since FROM claims WHERE issue = ? ORDER BY since", id).map((c) => ({
				agent: c.agent as string,
				change: c.change as number,
				since: c.since as number,
			})),
			children: this.statuses(this.rows("SELECT * FROM issues WHERE parent = ? ORDER BY id", id)),
		};
	}

	/**
	 * Open asks of someone (an agent's name or person:<id>), soonest due first, then oldest; every open ask without `of`.
	 * When `reader` is the one they're asked of, each listed for the first time is marked seen now; the answer still
	 * says null for those, so the reader can tell what's new.
	 */
	waiting(of?: string, reader?: string): (Ask & { title: string | null })[] {
		const select =
			"SELECT asks.*, issues.title FROM asks LEFT JOIN issues ON issues.id = asks.issue WHERE answer_at IS NULL";
		const rows =
			of === undefined
				? this.rows(`${select} ORDER BY due IS NULL, due, asks.id`)
				: this.rows(`${select} AND COALESCE(waiting_on, of) = ? ORDER BY due IS NULL, due, asks.id`, of);
		if (of !== undefined && reader === of)
			this.sql.exec(
				"UPDATE asks SET seen_at = ? WHERE of = ? AND answer_at IS NULL AND seen_at IS NULL",
				this.now(),
				of,
			);
		return rows.map((r) => ({
			...this.authoredAsk(this.withFiles(askOf(r))),
			title: (r.title as string | null) ?? null,
		}));
	}

	/** Asks of someone that have been answered, newest first. */
	answered(of: string, limit = 50): (Ask & { title: string | null })[] {
		return this.rows(
			"SELECT asks.*, issues.title FROM asks LEFT JOIN issues ON issues.id = asks.issue WHERE answer_at IS NOT NULL AND of = ? ORDER BY answer_at DESC LIMIT ?",
			of,
			limit,
		).map((r) => ({
			...this.authoredAsk(this.withFiles(askOf(r))),
			title: (r.title as string | null) ?? null,
		}));
	}

	/** The asks someone sent: every open one, oldest first, then the latest answered or withdrawn. */
	asked(by: string, answeredLimit = 10): (Ask & { title: string | null })[] {
		const select = "SELECT asks.*, issues.title FROM asks LEFT JOIN issues ON issues.id = asks.issue WHERE asks.by = ?";
		return [
			...this.rows(`${select} AND answer_at IS NULL ORDER BY asks.id`, by),
			...this.rows(`${select} AND answer_at IS NOT NULL ORDER BY answer_at DESC LIMIT ?`, by, answeredLimit),
		].map((r) => ({ ...this.authoredAsk(this.withFiles(askOf(r))), title: (r.title as string | null) ?? null }));
	}

	/** One ask, open or closed, with its thread and its issue's title. */
	askThread(id: number): Ask & { title: string | null } {
		const r = this.rows(
			"SELECT asks.*, issues.title FROM asks LEFT JOIN issues ON issues.id = asks.issue WHERE asks.id = ?",
			issueNumber(id, "an ask number"),
		)[0];
		if (!r) throw new IssuesError(`there's no ask ${id}`, 404);
		return { ...this.authoredAsk(this.withFiles(askOf(r))), title: (r.title as string | null) ?? null };
	}

	// Writes ---------------------------------------------------------------------------------

	/**
	 * A new issue. Agent is who it's for, Blocked by the issues it waits on,
	 * and Notify who the writer tells. The writer, its Agent and Notify watch
	 * it; Agent and Notify hear it now, and the parent's agents hear it too.
	 */
	open(actor: Actor, body: Parameters<IssuesStore["openRecord"]>[1]): { id: number; news?: News } {
		return this.transaction(() => this.openRecord(actor, body));
	}

	private openRecord(
		actor: Actor,
		body: {
			title?: unknown;
			description?: unknown;
			parent?: unknown;
			lines?: unknown;
			agent?: unknown;
			blockedBy?: unknown;
			notify?: unknown;
			labels?: unknown;
			attachments?: unknown;
		},
	): { id: number; news?: News } {
		const title = text(body.title, "the title", LIMITS.title, true, true);
		this.noAttachments(body.attachments);
		const description = text(body.description, "the description", LIMITS.description, false);
		const parent = this.parentFor(null, body.parent);
		const at_ = lines(body.lines);
		const agent = body.agent === undefined ? null : nameOrNone(body.agent, "the Agent");
		const blockedBy = this.blockersFor(null, body.blockedBy);
		const notify = names(body.notify, "Notify");
		const labels = labelsOf(body.labels);
		this.roomForLabels(labels);
		const open = this.rows("SELECT COUNT(*) AS n FROM issues WHERE closed_how IS NULL")[0]!.n as number;
		if (open >= LIMITS.open)
			throw new IssuesError(`this project has ${open} open issues, the most it can hold; close some first`);
		const at = this.now();
		const row = this.rows(
			"INSERT INTO issues (parent, title, description, opened_by, opened_at, updated_at, lines, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
			parent,
			title,
			description,
			who(actor),
			at,
			at,
			at_ ? JSON.stringify(at_) : null,
			agent,
		)[0]!;
		const id = row.id as number;
		for (const b of blockedBy) this.sql.exec("INSERT INTO blocked_by (issue, blocker) VALUES (?, ?)", id, b);
		for (const l of labels)
			this.sql.exec("INSERT INTO labels (issue, label, by, at) VALUES (?, ?, ?, ?)", id, l, who(actor), at);
		this.watch(id, who(actor), agent, ...notify);
		this.touch(parent);
		const to = unique([...(agent !== null ? [agent] : []), ...notify]).filter((p) => p !== who(actor));
		if (parent === null && to.length === 0) return { id };
		const detail = [
			agent !== null ? `Agent ${agent}` : "",
			blockedBy.length > 0 ? `blocked by ${blockedBy.join(", ")}` : "",
		].filter((d) => d !== "");
		return {
			id,
			news: {
				issue: parent,
				text: `${who(actor)} opened issue ${id}${parent !== null ? ` under issue ${parent}` : ""}: ${JSON.stringify(title)}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`,
				...(to.length > 0 ? { to } : {}),
			},
		};
	}

	/**
	 * An edit: title, description, parent, Agent, Blocked by or labels, kept in
	 * the issue's activity. It tells the watchers unless `notify` is false;
	 * `also` adds people, who watch it from then on (they were named in Notify).
	 * Labels are `labels` (the whole set) or `addLabels` and `removeLabels`; an
	 * edit that only changes labels tells nobody unless `notify` is true, since
	 * agents sort issues by label all the time.
	 */
	edit(
		actor: Actor,
		id: number,
		body: {
			title?: unknown;
			description?: unknown;
			parent?: unknown;
			agent?: unknown;
			blockedBy?: unknown;
			notify?: unknown;
			also?: unknown;
			labels?: unknown;
			addLabels?: unknown;
			removeLabels?: unknown;
		},
	): { edit: number; notified: string[]; news?: News } {
		const row = this.exists(id);
		const changes: Edit["changes"] = {};
		const sets: [string, unknown][] = [];
		if (body.title !== undefined) {
			const title = text(body.title, "the title", LIMITS.title, true, true);
			if (title !== row.title) (changes.title = { from: row.title, to: title }), sets.push(["title", title]);
		}
		if (body.description !== undefined) {
			const description = text(body.description, "the description", LIMITS.description, false);
			if (description !== row.description)
				(changes.description = { from: row.description, to: description }), sets.push(["description", description]);
		}
		if (body.parent !== undefined) {
			const parent = this.parentFor(id, body.parent);
			if (parent !== ((row.parent as number | null) ?? null))
				(changes.parent = { from: row.parent ?? null, to: parent }), sets.push(["parent", parent]);
		}
		if (body.agent !== undefined) {
			const agent = nameOrNone(body.agent, "the Agent");
			if (agent !== ((row.agent as string | null | undefined) ?? null))
				(changes.agent = { from: row.agent ?? null, to: agent }), sets.push(["agent", agent]);
		}
		let blockedBy: number[] | undefined;
		if (body.blockedBy !== undefined) {
			blockedBy = this.blockersFor(id, body.blockedBy);
			const before = this.rows("SELECT blocker FROM blocked_by WHERE issue = ? ORDER BY blocker", id).map(
				(b) => b.blocker as number,
			);
			const after = [...blockedBy].sort((a, b) => a - b);
			if (before.join() !== after.join()) changes.blockedBy = { from: before, to: after };
			else blockedBy = undefined;
		}
		let labels: string[] | undefined;
		if (body.labels !== undefined || body.addLabels !== undefined || body.removeLabels !== undefined) {
			if (body.labels !== undefined && (body.addLabels !== undefined || body.removeLabels !== undefined))
				throw new IssuesError("labels is the whole set; addLabels and removeLabels change it; send one or the other");
			const before = this.rows("SELECT label FROM labels WHERE issue = ? ORDER BY label", id).map(
				(l) => l.label as string,
			);
			const drop = new Set(labelsOf(body.removeLabels, "removeLabels"));
			const after =
				body.labels !== undefined
					? labelsOf(body.labels)
					: labelsOf([...before.filter((l) => !drop.has(l)), ...labelsOf(body.addLabels, "addLabels")]);
			if (before.join() !== after.join()) {
				this.roomForLabels(after);
				changes.labels = { from: before, to: after };
				labels = after;
			}
		}
		if (body.notify !== undefined && typeof body.notify !== "boolean")
			throw new IssuesError("notify is true (tell the watchers, the default) or false (tell nobody)");
		const also = names(body.also, "who else to tell");
		if (Object.keys(changes).length === 0) throw new IssuesError(`that changes nothing on issue ${id}`);
		const labelsOnly = Object.keys(changes).every((k) => k === "labels");
		const e = this.transaction(() => {
			for (const [column, value] of sets) this.sql.exec(`UPDATE issues SET ${column} = ? WHERE id = ?`, value, id);
			if (blockedBy !== undefined) {
				this.sql.exec("DELETE FROM blocked_by WHERE issue = ?", id);
				for (const b of blockedBy) this.sql.exec("INSERT INTO blocked_by (issue, blocker) VALUES (?, ?)", id, b);
			}
			if (labels !== undefined) {
				// A label kept keeps who added it and when.
				for (const l of this.rows("SELECT label FROM labels WHERE issue = ?", id))
					if (!labels.includes(l.label as string))
						this.sql.exec("DELETE FROM labels WHERE issue = ? AND label = ?", id, l.label);
				for (const l of labels)
					this.sql.exec(
						"INSERT OR IGNORE INTO labels (issue, label, by, at) VALUES (?, ?, ?, ?)",
						id,
						l,
						who(actor),
						this.now(),
					);
			}
			this.watch(id, (changes.agent?.to as string | null | undefined) ?? null, ...also);
			const notified =
				body.notify === false || (labelsOnly && body.notify !== true)
					? []
					: unique([...this.watchersOf(id), ...also]).filter((p) => p !== who(actor));
			const edit = this.rows(
				"INSERT INTO edits (issue, by, changes, notified, at) VALUES (?, ?, ?, ?, ?) RETURNING id",
				id,
				who(actor),
				JSON.stringify(changes),
				JSON.stringify(notified),
				this.now(),
			)[0]!.id as number;
			return { id: edit, notified };
		});
		const notified = e.notified;
		this.touch(id, (row.parent as number | null) ?? null, (changes.parent?.to as number | null | undefined) ?? null);
		if (notified.length === 0) return { edit: e.id as number, notified };
		const title = (changes.title?.to as string | undefined) ?? (row.title as string);
		const said = [
			changes.title ? `title was ${JSON.stringify(changes.title.from)}` : "",
			changes.description ? "description changed" : "",
			changes.parent ? (changes.parent.to === null ? "no parent now" : `parent is issue ${changes.parent.to}`) : "",
			changes.agent ? (changes.agent.to === null ? "no Agent now" : `Agent is ${changes.agent.to}`) : "",
			changes.blockedBy
				? (changes.blockedBy.to as number[]).length === 0
					? "blocked by nothing now"
					: `blocked by ${(changes.blockedBy.to as number[]).join(", ")}`
				: "",
			changes.labels
				? (changes.labels.to as string[]).length === 0
					? "no labels now"
					: `labels ${(changes.labels.to as string[]).join(", ")}`
				: "",
		].filter((s) => s !== "");
		return {
			edit: e.id as number,
			notified,
			news: {
				issue: null,
				text: `${who(actor)} edited issue ${id} (${JSON.stringify(title)}): ${said.join("; ")}`,
				to: notified,
			},
		};
	}

	comment(
		actor: Actor,
		id: number,
		body: { text?: unknown; objection?: unknown; attachments?: unknown },
	): { id: number; news: News } {
		const row = this.exists(id);
		const t = text(body.text, "the comment", LIMITS.text);
		this.noAttachments(body.attachments);
		const kind = body.objection === true ? "objection" : "comment";
		const c = this.rows(
			"INSERT INTO comments (issue, by, kind, text, at) VALUES (?, ?, ?, ?, ?) RETURNING id",
			id,
			who(actor),
			kind,
			t,
			this.now(),
		)[0]!;
		this.watch(id, who(actor));
		this.touch(id);
		// @name in the text tells that agent too; the project drops names that aren't its agents.
		const mentioned = mentionsIn(t).filter((name) => name !== who(actor));
		return {
			id: c.id as number,
			news: {
				issue: id,
				text: `${who(actor)} ${kind === "objection" ? "objects" : "comments"} on issue ${id} (${JSON.stringify(row.title)}): ${JSON.stringify(t)}`,
				...(mentioned.length > 0 ? { to: mentioned } : {}),
			},
		};
	}

	/**
	 * An ask: a question or a task for someone, on an issue or on none. A
	 * review ask (`review`) puts its issue In review; any other holds it up
	 * (Blocked), and so do the issues it names in `blocks`.
	 */
	ask(
		actor: Actor,
		body: {
			issue?: unknown;
			of?: unknown;
			question?: unknown;
			review?: unknown;
			kind?: unknown;
			due?: unknown;
			recommendation?: unknown;
			options?: unknown;
			blocks?: unknown;
			attachments?: unknown;
		},
	): { id: number; news: News } {
		const issue = body.issue === undefined || body.issue === null ? null : issueNumber(body.issue);
		const row = issue === null ? undefined : this.exists(issue);
		if (row?.closed_how) throw new IssuesError(`issue ${issue} is closed`);
		const of = text(body.of, "who it asks", 100, true, true);
		const question = text(body.question, "the question", LIMITS.text);
		const kind = body.kind === undefined || body.kind === null ? "question" : body.kind;
		if (kind !== "question" && kind !== "task")
			throw new IssuesError('kind is "question", or "task" for something only they can do');
		const review = body.review === true;
		if (review && issue === null) throw new IssuesError("a review ask is on an issue");
		let due: string | null = null;
		if (body.due !== undefined && body.due !== null && body.due !== "") {
			if (typeof body.due !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(body.due) || Number.isNaN(Date.parse(body.due)))
				throw new IssuesError("due is a date, like 2026-10-14");
			due = body.due;
		}
		let recommendation: { text: string; by: string } | null = null;
		if (body.recommendation !== undefined && body.recommendation !== null) {
			const r = body.recommendation as { text?: unknown; by?: unknown };
			recommendation = {
				text: text(r.text, "the recommendation", LIMITS.text),
				by: r.by === undefined ? who(actor) : text(r.by, "who recommends it", 100, true, true),
			};
		}
		const options = body.options === undefined || body.options === null ? [] : body.options;
		if (!Array.isArray(options) || options.length > LIMITS.options)
			throw new IssuesError(`options are a list of up to ${LIMITS.options} choices`);
		const choices = options.map((o, i) => text(o, `option ${i + 1}`, 500, true, true));
		const blocks = body.blocks === undefined || body.blocks === null ? [] : body.blocks;
		if (!Array.isArray(blocks) || blocks.length > LIMITS.blocks)
			throw new IssuesError(`blocks is a list of up to ${LIMITS.blocks} issue numbers`);
		const held = [...new Set(blocks.map((b) => issueNumber(b, "an issue it blocks")))].filter((b) => b !== issue);
		for (const b of held) this.exists(b);
		this.noAttachments(body.attachments);
		const a = this.rows(
			"INSERT INTO asks (issue, by, of, kind, question, review, due, recommendation, options, blocks, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
			issue,
			who(actor),
			of,
			kind,
			question,
			review ? 1 : 0,
			due,
			recommendation ? JSON.stringify(recommendation) : null,
			JSON.stringify(choices),
			JSON.stringify(held),
			this.now(),
		)[0]!;
		if (review && issue !== null) this.watch(issue, of);
		this.touch(issue, ...held);
		const what = review ? "for a review" : kind === "task" ? "to do something" : "a question";
		const where = issue === null ? "" : ` on issue ${issue} (${JSON.stringify(row!.title)})`;
		return {
			id: a.id as number,
			// An agent asked hears how to answer.
			news: {
				issue,
				text: `${who(actor)} asks ${of} ${what}${where}: ${JSON.stringify(question)}${of.startsWith("person:") ? "" : ` Answer: abso answer ${a.id} "..."`}`,
				to: [of],
			},
		};
	}

	/** An answer, in the answerer's own words, kept on the ask. Only the one asked answers; a task is answered "done". */
	answer(
		actor: Actor,
		askId: number,
		body: {
			words?: unknown;
			option?: unknown;
			expect?: unknown;
			note?: unknown;
			done?: unknown;
			attachments?: unknown;
		},
	): { ask: Ask; news: News } {
		const r = this.rows("SELECT * FROM asks WHERE id = ?", issueNumber(askId, "an ask number"))[0];
		if (!r) throw new IssuesError(`there's no ask ${askId}`, 404);
		if (r.of !== who(actor)) throw new IssuesError(`ask ${askId} is for ${r.of as string}, not ${who(actor)}`, 403);
		if (r.answer_at !== null && r.answer_at !== undefined)
			throw new IssuesError(
				r.outcome === "withdrawn"
					? `ask ${askId} was withdrawn by ${r.answer_by as string}, who asked it; it needs no answer`
					: `ask ${askId} is answered already`,
				409,
			);
		const words = this.answerWordsFor(r, body);
		this.noAttachments(body.attachments);
		const at = this.now();
		this.sql.exec(
			"UPDATE asks SET answer_by = ?, answer_words = ?, answer_at = ? WHERE id = ?",
			who(actor),
			words,
			at,
			r.id,
		);
		const ask = this.authoredAsk(
			this.withFiles(askOf({ ...r, answer_by: who(actor), answer_words: words, answer_at: at })),
		);
		this.touch(ask.issue, ...ask.blocks);
		return {
			ask,
			news: {
				issue: ask.issue,
				text: `${who(actor)} answered ${ask.by}'s ${ask.review ? "review ask" : ask.kind}${ask.issue !== null ? ` on issue ${ask.issue}` : ""}: ${JSON.stringify(words)}`,
				to: [ask.by],
			},
		};
	}

	private answerWordsFor(
		r: Row,
		body: { words?: unknown; option?: unknown; expect?: unknown; note?: unknown; done?: unknown },
	): string {
		const askId = r.id as number;
		const options = JSON.parse(r.options as string) as string[];
		if (body.option !== undefined && body.option !== null) {
			const pick = typeof body.option === "number" ? options[body.option] : options.find((o) => o === body.option);
			if (pick === undefined)
				throw new IssuesError(`ask ${askId}'s options are: ${options.map((o) => JSON.stringify(o)).join(", ")}`);
			if (body.expect !== undefined && body.expect !== pick)
				throw new IssuesError(
					`ask ${askId}'s option ${Number(body.option) + 1} is ${JSON.stringify(pick)}, not the one you picked; look again`,
					409,
				);
			const note = text(body.note, "the note", LIMITS.text, false);
			return note === "" ? pick : `${pick}\n\n${note}`;
		}
		if (body.done === true && r.kind === "task") {
			const note = text(body.note, "the note", LIMITS.text, false);
			return note === "" ? "done" : `done\n\n${note}`;
		}
		return text(body.words, "the answer", LIMITS.text);
	}

	/**
	 * The one asked says they have it and will answer later. The ask stays open and keeps
	 * blocking; it shows as acknowledged, and the asker hears it with the note. Acknowledging again updates
	 * the note and the time. abso answer closes it as before.
	 */
	ack(actor: Actor, askId: number, body: { note?: unknown }): { ask: Ask; news: News } {
		const r = this.rows("SELECT * FROM asks WHERE id = ?", issueNumber(askId, "an ask number"))[0];
		if (!r) throw new IssuesError(`there's no ask ${askId}`, 404);
		if (r.of !== who(actor)) throw new IssuesError(`ask ${askId} is for ${r.of as string}, not ${who(actor)}`, 403);
		if (r.answer_at !== null && r.answer_at !== undefined)
			throw new IssuesError(
				r.outcome === "withdrawn"
					? `ask ${askId} was withdrawn by ${r.answer_by as string}, who asked it; it needs no answer`
					: `ask ${askId} is answered already`,
				409,
			);
		const note = text(body.note, "the note", LIMITS.text, false);
		const at = this.now();
		this.transaction(() => {
			this.sql.exec("UPDATE asks SET ack_at = ?, ack_note = ? WHERE id = ?", at, note, r.id);
			// The note is a reply in the thread.
			if (note !== "")
				this.sql.exec(
					"INSERT INTO ask_replies (ask, by, text, question, at) VALUES (?, ?, ?, 0, ?)",
					r.id,
					who(actor),
					note,
					at,
				);
		});
		const ask = this.authoredAsk(this.withFiles(askOf({ ...r, ack_at: at, ack_note: note })));
		this.touch(ask.issue);
		return {
			ask,
			news: {
				issue: ask.issue,
				text: `${who(actor)} has your ${ask.review ? "review ask" : ask.kind} (ask ${ask.id})${ask.issue !== null ? ` on issue ${ask.issue}` : ""} and will answer${note !== "" ? `: ${JSON.stringify(note)}` : "."}`,
				to: [ask.by],
			},
		};
	}

	/**
	 * A reply on an ask's thread, from the one asked or the asker, open or closed. The other side
	 * hears it. Whose turn it is: a reply from the one asked marked as a question waits on the asker; the asker's
	 * next reply hands it back. Answering still closes it.
	 */
	reply(actor: Actor, askId: number, body: { text?: unknown; question?: unknown }): { ask: Ask; news: News } {
		const r = this.rows("SELECT * FROM asks WHERE id = ?", issueNumber(askId, "an ask number"))[0];
		if (!r) throw new IssuesError(`there's no ask ${askId}`, 404);
		const me = who(actor);
		if (me !== r.of && me !== r.by)
			throw new IssuesError(
				`ask ${askId} is between ${r.by as string} and ${r.of as string}; only they reply on it. abso comment says something on its issue`,
				403,
			);
		const words = text(body.text, "the reply", LIMITS.text);
		const question = body.question === true;
		const open = r.answer_at === null || r.answer_at === undefined;
		let waitingOn = (r.waiting_on as string | null) ?? null;
		if (open) {
			if (me === r.of && me !== r.by) {
				if (question) waitingOn = r.by as string;
			} else waitingOn = null;
		}
		const at = this.now();
		this.transaction(() => {
			this.sql.exec(
				"INSERT INTO ask_replies (ask, by, text, question, at) VALUES (?, ?, ?, ?, ?)",
				r.id,
				me,
				words,
				question ? 1 : 0,
				at,
			);
			if (open) this.sql.exec("UPDATE asks SET waiting_on = ? WHERE id = ?", waitingOn, r.id);
		});
		const ask = this.authoredAsk(this.withFiles(askOf({ ...r, waiting_on: waitingOn })));
		this.touch(ask.issue);
		const other = me === ask.of ? ask.by : ask.of;
		const turn = open && (waitingOn ?? ask.of) === other ? " It waits on you." : "";
		return {
			ask,
			news: {
				issue: ask.issue,
				text: `${me} replied on ask ${ask.id}${ask.issue !== null ? ` (issue ${ask.issue})` : ""}${question ? " with a question" : ""}: ${JSON.stringify(words)}${turn}${other.startsWith("person:") ? "" : ` abso ask ${ask.id} shows the thread.`}`,
				to: [other],
			},
		};
	}

	/**
	 * The asker takes back an ask nobody needs answered any more. It closes as an answer does
	 * (answer_at set, so it leaves waiting and stops blocking), with the asker as answer_by, their note as
	 * answer_words, and outcome 'withdrawn'. The one asked hears it.
	 */
	withdraw(actor: Actor, askId: number, body: { note?: unknown }): { ask: Ask; news: News } {
		const r = this.rows("SELECT * FROM asks WHERE id = ?", issueNumber(askId, "an ask number"))[0];
		if (!r) throw new IssuesError(`there's no ask ${askId}`, 404);
		if (r.by !== who(actor))
			throw new IssuesError(`ask ${askId} was asked by ${r.by as string}; only they can withdraw it`, 403);
		if (r.answer_at !== null && r.answer_at !== undefined)
			throw new IssuesError(
				r.outcome === "withdrawn"
					? `ask ${askId} is withdrawn already`
					: `ask ${askId} is answered already, so there's nothing to withdraw`,
				409,
			);
		const note = text(body.note, "the note", LIMITS.text, false);
		const at = this.now();
		this.sql.exec(
			"UPDATE asks SET answer_by = ?, answer_words = ?, answer_at = ?, outcome = 'withdrawn' WHERE id = ?",
			who(actor),
			note,
			at,
			r.id,
		);
		const ask = this.authoredAsk(
			this.withFiles(askOf({ ...r, answer_by: who(actor), answer_words: note, answer_at: at, outcome: "withdrawn" })),
		);
		this.touch(ask.issue, ...ask.blocks);
		return {
			ask,
			news: {
				issue: ask.issue,
				text: `${who(actor)} withdrew their ${ask.review ? "review ask" : ask.kind} of ${ask.of}${ask.issue !== null ? ` on issue ${ask.issue}` : ""}${note !== "" ? `: ${JSON.stringify(note)}` : ""}`,
				to: [ask.of],
			},
		};
	}

	/** Dropped by hand; done comes only from a publish (the done hook). */
	drop(actor: Actor, id: number): { news: News } {
		const row = this.exists(id);
		if (row.closed_how)
			throw new IssuesError(`issue ${id} is ${row.closed_how === "done" ? "done" : "dropped"} already`, 409);
		this.sql.exec(
			"UPDATE issues SET closed_how = 'dropped', closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?",
			who(actor),
			this.now(),
			this.now(),
			id,
		);
		this.sql.exec("DELETE FROM claims WHERE issue = ?", id);
		return { news: { issue: id, text: `${who(actor)} dropped issue ${id} (${JSON.stringify(row.title)})` } };
	}

	/** A dropped issue opens again. A done issue stays done. */
	reopen(actor: Actor, id: number): { news: News } {
		const row = this.exists(id);
		if (row.closed_how !== "dropped")
			throw new IssuesError(
				row.closed_how === "done" ? `issue ${id} is done; it stays done` : `issue ${id} is open`,
				409,
			);
		this.sql.exec(
			"UPDATE issues SET closed_how = NULL, closed_by = NULL, closed_version = NULL, closed_at = NULL, updated_at = ? WHERE id = ?",
			this.now(),
			id,
		);
		this.touch(id);
		return { news: { issue: id, text: `${who(actor)} reopened issue ${id} (${JSON.stringify(row.title)})` } };
	}

	/**
	 * Marked done by hand, by a person or an agent. `version`, when
	 * given, is the published version that did the work. A dropped issue is reopened first.
	 */
	markDone(actor: Actor, id: number, version: number | null): { news: News } {
		const row = this.exists(id);
		if (row.closed_how === "dropped")
			throw new IssuesError(`issue ${id} is dropped; reopen it before marking it done`, 409);
		if (row.closed_how === "done") throw new IssuesError(`issue ${id} is done already`, 409);
		if (version !== null && (!Number.isInteger(version) || version < 1))
			throw new IssuesError("version is a published version, 1 or more");
		const at = this.now();
		const by = who(actor);
		if (version !== null)
			this.sql.exec(
				"INSERT INTO versions (issue, version, agent, at) VALUES (?, ?, ?, ?) ON CONFLICT (issue, version) DO NOTHING",
				id,
				version,
				by,
				at,
			);
		this.sql.exec(
			"UPDATE issues SET closed_how = 'done', closed_by = ?, closed_version = ?, closed_at = ?, updated_at = ? WHERE id = ?",
			by,
			version,
			at,
			at,
			id,
		);
		this.sql.exec("DELETE FROM claims WHERE issue = ?", id);
		const where = version === null ? "by hand" : `in version ${version}`;
		return {
			news: { issue: id, text: `${by} marked issue ${id} (${JSON.stringify(row.title)}) done ${where}` },
		};
	}

	/**
	 * Refuses a write past the writer's limit: WRITES_PER_MINUTE a
	 * minute and WRITES_PER_DAY a day, opens, edits, comments, asks, answers and
	 * drops together. A 429 says when to try again.
	 */
	checkLimit(actor: Actor): void {
		const now = this.now();
		this.sql.exec("DELETE FROM writes WHERE who = ? AND at <= ?", who(actor), now - 86_400_000);
		const times = this.rows("SELECT at FROM writes WHERE who = ? ORDER BY at", who(actor)).map((w) => w.at as number);
		const minute = times.filter((t) => now - t < 60_000);
		if (minute.length >= WRITES_PER_MINUTE)
			throw new IssuesError(
				`at most ${WRITES_PER_MINUTE} issue writes a minute; try again shortly`,
				429,
				Math.max(1, Math.ceil((minute[0]! + 60_000 - now) / 1000)),
			);
		if (times.length >= WRITES_PER_DAY)
			throw new IssuesError(
				`at most ${WRITES_PER_DAY} issue writes a day in a project`,
				429,
				Math.max(1, Math.ceil((times[0]! + 86_400_000 - now) / 1000)),
			);
	}

	/** Counts a write that went through. */
	wrote(actor: Actor): void {
		this.sql.exec("INSERT INTO writes (who, at) VALUES (?, ?)", who(actor), this.now());
	}

	// Drafts: a writer's own, with no number and no news ------------------------

	/** The actor's drafts, newest first. Nobody else's. */
	drafts(actor: Actor): Draft[] {
		return this.rows("SELECT * FROM drafts WHERE owner = ? ORDER BY saved_at DESC, id DESC", who(actor)).map(asDraft);
	}

	/**
	 * Saves a draft, new or (with `id`) over one of the actor's. Any field may
	 * be empty; what's there is checked as open would check it, but not whether
	 * the issues it names still exist (that waits for opening).
	 */
	saveDraft(
		actor: Actor,
		body: {
			id?: unknown;
			title?: unknown;
			description?: unknown;
			parent?: unknown;
			lines?: unknown;
			agent?: unknown;
			blockedBy?: unknown;
			notify?: unknown;
			labels?: unknown;
		},
	): { id: number } {
		const draft: DraftBody = {};
		const title = text(body.title, "the title", LIMITS.title, false, true);
		if (title !== "") draft.title = title;
		const description = text(body.description, "the description", LIMITS.description, false);
		if (description !== "") draft.description = description;
		if (body.parent !== undefined && body.parent !== null) draft.parent = issueNumber(body.parent, "the parent");
		const l = lines(body.lines);
		if (l !== null) draft.lines = l;
		if (body.agent !== undefined && body.agent !== null && body.agent !== "")
			draft.agent = nameOrNone(body.agent, "the Agent");
		if (body.blockedBy !== undefined && body.blockedBy !== null) {
			if (!Array.isArray(body.blockedBy) || body.blockedBy.length > LIMITS.blocks)
				throw new IssuesError(`blocked by is a list of up to ${LIMITS.blocks} issue numbers`);
			draft.blockedBy = [...new Set(body.blockedBy.map((b) => issueNumber(b, "an issue it's blocked by")))];
		}
		const notify = names(body.notify, "Notify");
		if (notify.length > 0) draft.notify = notify;
		const labels = labelsOf(body.labels);
		if (labels.length > 0) draft.labels = labels;
		const saved = JSON.stringify(draft);
		if (saved.length > LIMITS.draft) throw new IssuesError(`a draft holds at most ${LIMITS.draft} characters`);
		if (body.id !== undefined && body.id !== null) {
			const id = this.draftOf(actor, body.id).id as number;
			this.sql.exec("UPDATE drafts SET body = ?, saved_at = ? WHERE id = ?", saved, this.now(), id);
			return { id };
		}
		const n = this.rows("SELECT COUNT(*) AS n FROM drafts WHERE owner = ?", who(actor))[0]!.n as number;
		if (n >= LIMITS.drafts)
			throw new IssuesError(`you have ${n} drafts, the most there can be; open or delete some first`);
		return {
			id: this.rows(
				"INSERT INTO drafts (owner, body, saved_at) VALUES (?, ?, ?) RETURNING id",
				who(actor),
				saved,
				this.now(),
			)[0]!.id as number,
		};
	}

	deleteDraft(actor: Actor, id: number): void {
		this.sql.exec("DELETE FROM drafts WHERE id = ?", this.draftOf(actor, id).id);
	}

	/** Opens a draft as an issue, with `body`'s fields over the draft's, and deletes the draft. The issue's news is the only news. */
	openDraft(actor: Actor, id: number, body: Record<string, unknown> = {}): { id: number; news?: News } {
		const d = this.draftOf(actor, id);
		const opened = this.open(actor, { ...(JSON.parse(d.body as string) as DraftBody), ...body });
		this.sql.exec("DELETE FROM drafts WHERE id = ?", d.id);
		return opened;
	}

	/** One of the actor's drafts; another's is "no such draft", as if it weren't there. */
	private draftOf(actor: Actor, id: unknown): Row {
		const row = this.rows(
			"SELECT * FROM drafts WHERE id = ? AND owner = ?",
			issueNumber(id, "a draft number"),
			who(actor),
		)[0];
		if (!row) throw new IssuesError(`you have no draft ${String(id)}`, 404);
		return row;
	}
	// From the project: start notes and publish --done ----------------------------------------

	/** A start note names the issue (`change` is the note's log position). One that doesn't exist, or is closed, is ignored: the note stands either way. */
	claim(agent: string, id: number, change: number): void {
		const row = this.rows("SELECT closed_how FROM issues WHERE id = ?", id)[0];
		if (!row || row.closed_how) return;
		this.sql.exec(
			"INSERT INTO claims (issue, agent, change, since) VALUES (?, ?, ?, ?) ON CONFLICT (issue, agent) DO UPDATE SET change = excluded.change, since = excluded.since",
			id,
			agent,
			change,
			this.now(),
		);
		this.sql.exec("UPDATE issues SET agent = ? WHERE id = ? AND agent IS NULL", agent, id);
		this.watch(id, agent);
		this.touch(id);
	}

	/** The start note ended without finishing the issue. */
	unclaim(agent: string, id: number): void {
		this.sql.exec("DELETE FROM claims WHERE issue = ? AND agent = ?", id, agent);
		this.touch(id);
	}

	/** publish --done finished it, with that version of shared: done, and the version is one out for it. */
	done(agent: string, id: number, version: number): { news?: News } {
		this.sql.exec("DELETE FROM claims WHERE issue = ? AND agent = ?", id, agent);
		const row = this.rows("SELECT title, closed_how FROM issues WHERE id = ?", id)[0];
		if (!row) return {};
		this.sql.exec(
			"INSERT INTO versions (issue, version, agent, at) VALUES (?, ?, ?, ?) ON CONFLICT (issue, version) DO NOTHING",
			id,
			version,
			agent,
			this.now(),
		);
		this.touch(id);
		if (row.closed_how) return {};
		this.sql.exec(
			"UPDATE issues SET closed_how = 'done', closed_by = ?, closed_version = ?, closed_at = ? WHERE id = ?",
			agent,
			version,
			this.now(),
			id,
		);
		this.sql.exec("DELETE FROM claims WHERE issue = ?", id);
		return {
			news: { issue: id, text: `${agent} finished issue ${id} (${JSON.stringify(row.title)}) in version ${version}` },
		};
	}
}

function asDraft(d: Row): Draft {
	return {
		id: d.id as number,
		body: JSON.parse(d.body as string) as DraftBody,
		saved: d.saved_at as number,
	};
}

/** A snippet with \u0001 and \u0002 around each match, as plain text and the matches' spans. */
function marked(snip: string): { text: string; marks: number[][] } {
	let text = "";
	const marks: number[][] = [];
	let open = -1;
	for (const ch of snip) {
		if (ch === "\u0001") open = text.length;
		else if (ch === "\u0002") {
			if (open >= 0) marks.push([open, text.length]);
			open = -1;
		} else text += ch;
	}
	return { text, marks };
}

function askOf(r: Row): StoredAsk {
	return {
		id: r.id as number,
		issue: (r.issue as number | null) ?? null,
		by: r.by as string,
		of: r.of as string,
		kind: r.kind as Ask["kind"],
		question: r.question as string,
		review: r.review === 1,
		due: (r.due as string | null) ?? null,
		recommendation: r.recommendation ? (JSON.parse(r.recommendation as string) as Ask["recommendation"]) : null,
		options: JSON.parse(r.options as string) as string[],
		blocks: JSON.parse(r.blocks as string) as number[],
		at: r.at as number,
		answer:
			r.answer_at !== null && r.answer_at !== undefined
				? { by: r.answer_by as string, words: r.answer_words as string, at: r.answer_at as number }
				: null,
		seen: (r.seen_at as number | null | undefined) ?? null,
		waitingOn:
			r.answer_at !== null && r.answer_at !== undefined ? null : ((r.waiting_on as string | null) ?? (r.of as string)),
		replies: [],
		...(r.outcome === "withdrawn" ? { outcome: "withdrawn" as const } : {}),
		...(typeof r.ack_at === "number" ? { ack: { at: r.ack_at, note: (r.ack_note as string | null) ?? "" } } : {}),
	};
}
