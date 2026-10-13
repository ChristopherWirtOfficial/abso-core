// The engine's Project (worker/project/project.ts) behind the server's calls, with its append-only log kept in the
// Durable Object's SQLite. An entry longer than one row allows (init holds every starting file; SQLite rows stop at
// 2 MB) is split across rows and joined on load. Ported from the platform's worker/src/engine-project.ts; the
// writer-adoption and R2 version parts are left out.

import { blame, folderBlame, why } from "../../worker/project/blame.ts";
import { feedEvents } from "../../worker/project/feed.ts";
import { type Entry, type ProjectStore as LogStore, MemoryStore, Project } from "../../worker/project/project.ts";
import type { EditBody, ProjectCalls, ProjectHistory } from "../../worker/project/project-api.ts";
import { where } from "../../worker/project/where.ts";

/** The parts of a Durable Object's storage the log and blob store use, declared structurally so tests can stand in. */
export interface SqliteStorage {
	sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };
	transactionSync<T>(fn: () => T): T;
}

// Characters per row. SQLite's 2 MB cap is in bytes, and a character is at
// most 3 bytes of UTF-8 (an emoji is 2 characters and 4 bytes), so 600,000 stays under it.
export const LOG_PART_CHARACTERS = 600_000;

/** An entry's JSON in rows of at most LOG_PART_CHARACTERS characters, never cutting an emoji's two halves apart. */
export function logParts(text: string): string[] {
	const parts: string[] = [];
	let at = 0;
	do {
		let end = Math.min(at + LOG_PART_CHARACTERS, text.length);
		const c = text.charCodeAt(end - 1);
		if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
		parts.push(text.slice(at, end));
		at = end;
	} while (at < text.length);
	return parts;
}

/** The lines an entry's atoms write: what a loaded project's size grows with (#46, #56). */
function linesIn(entry: Entry): number {
	let n = 0;
	for (const a of [
		(entry as { atom?: { inserts?: { lines: unknown[] }[] } }).atom,
		(entry as { tie?: { inserts?: { lines: unknown[] }[] } }).tie,
	]) {
		for (const r of a?.inserts ?? []) n += r.lines.length;
	}
	return n;
}

/** The version of shared an entry makes, or undefined (abso issue 78: the access check reads it without loading). */
function sharedVersionOf(entry: Entry): number | undefined {
	if (entry.type === "init") return 0;
	if (entry.type === "land" || entry.type === "drop") return entry.version;
	if (entry.type === "publish" && (entry.space ?? "") === "") return entry.version;
	return undefined;
}

/** Who made that version of shared, and when. Init is not a publish (abso issue 86). */
function lastPublishOf(entry: Entry): { agent: string; time: number } | undefined {
	if (entry.type === "land" || entry.type === "drop") return { agent: entry.agent, time: entry.time };
	if (entry.type === "publish" && (entry.space ?? "") === "") return { agent: entry.agent, time: entry.time };
	return undefined;
}

/** An entry's claim keys and deletes (#46): with entries and lines, what the load guard estimates memory by. */
function keysIn(entry: Entry): number {
	let n = 0;
	for (const a of [
		(entry as { atom?: Partial<Record<"writes" | "reads" | "holds" | "deletes", unknown[]>> }).atom,
		(entry as { tie?: Partial<Record<"writes" | "reads" | "holds" | "deletes", unknown[]>> }).tie,
	]) {
		if (a) n += (a.writes?.length ?? 0) + (a.reads?.length ?? 0) + (a.holds?.length ?? 0) + (a.deletes?.length ?? 0);
	}
	return n;
}

export class SqliteLog implements LogStore {
	private storage: SqliteStorage;
	private next: number;

	constructor(storage: SqliteStorage) {
		this.storage = storage;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS log (seq INTEGER, part INTEGER, text TEXT NOT NULL, PRIMARY KEY (seq, part))",
		);
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS shapes (space TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (space, version))",
		);
		storage.sql.exec("CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
		storage.sql.exec("CREATE TABLE IF NOT EXISTS marks (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const rows = storage.sql.exec("SELECT COALESCE(MAX(seq), -1) AS last FROM log").toArray() as { last: number }[];
		this.next = (rows[0]?.last ?? -1) + 1;
	}

	/** The seq the next entry would take. A copy's next page must start here. */
	seq(): number {
		return this.next;
	}

	/** Reject an oversized canonical frame before loading its text into JavaScript. */
	boundedFrame(seq: number, maxBytes: number): string {
		if (
			!Number.isSafeInteger(seq) ||
			seq < 0 ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > 8_000_000
		)
			throw new Error("invalid canonical frame bound");
		const size = this.storage.sql
			.exec(
				"SELECT COUNT(*) AS parts, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM log WHERE seq = ?",
				seq,
			)
			.toArray()[0] as { parts: number; bytes: number };
		if (!size || size.parts < 1 || size.parts > 256 || size.bytes > maxBytes)
			throw new Error("canonical frame exceeds adoption bound or is missing");
		const rows = this.storage.sql.exec("SELECT part, text FROM log WHERE seq = ? ORDER BY part", seq).toArray() as {
			part: number;
			text: string;
		}[];
		if (rows.length !== size.parts || rows.some((row, part) => row.part !== part))
			throw new Error("canonical frame parts are incomplete");
		return rows.map((row) => row.text).join("");
	}

	/** Refreshes the in-memory cursor after an enclosing transaction rolls back. */
	refreshSequence(): void {
		const rows = this.storage.sql.exec("SELECT COALESCE(MAX(seq), -1) AS last FROM log").toArray() as {
			last: number;
		}[];
		this.next = (rows[0]?.last ?? -1) + 1;
	}

	/** Monotonic cache invalidation epoch for every canonical log mutation. */
	generation(): number {
		const rows = this.storage.sql.exec("SELECT value FROM marks WHERE name = ?", "generation").toArray() as {
			value: string;
		}[];
		const generation = Number(rows[0]?.value ?? 0);
		if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("canonical log generation is invalid");
		return generation;
	}

	/**
	 * Lines ever recorded (#46, #56): what loading the project costs grows with
	 * this, not with the log's size, so a guard can read it without loading.
	 * Kept with each append; undefined for a log written before the count,
	 * until it next loads.
	 */
	lineCount(): number | undefined {
		const rows = this.storage.sql.exec("SELECT value FROM counts WHERE name = 'lines'").toArray() as {
			value: number;
		}[];
		return rows[0]?.value;
	}

	/**
	 * The newest version of shared, without loading the project (abso issue 78: the website's access check asked
	 * every project's engine for it). Kept with each append; a log from before the count is read once by streaming.
	 */
	sharedVersion(): number {
		const rows = this.storage.sql.exec("SELECT value FROM counts WHERE name = 'shared'").toArray() as {
			value: number;
		}[];
		if (rows[0] !== undefined) return rows[0].value;
		let version = -1;
		for (const e of this.#entries()) version = sharedVersionOf(e) ?? version;
		if (version >= 0)
			this.storage.sql.exec("INSERT OR REPLACE INTO counts (name, value) VALUES ('shared', ?)", version);
		return version;
	}

	/**
	 * Who published shared's newest version, and when, without loading the project (abso issue 86).
	 * Null when shared has no publish yet. A log from before the mark is read once by streaming.
	 */
	lastPublish(): { agent: string; time: number } | null {
		const rows = this.storage.sql.exec("SELECT value FROM marks WHERE name = ?", "last").toArray() as {
			value: string;
		}[];
		if (rows[0] !== undefined) return JSON.parse(rows[0].value) as { agent: string; time: number };
		let last: { agent: string; time: number } | null = null;
		for (const e of this.#entries()) {
			const found = lastPublishOf(e);
			if (found) last = found;
		}
		if (last)
			this.storage.sql.exec("INSERT OR REPLACE INTO marks (name, value) VALUES (?, ?)", "last", JSON.stringify(last));
		return last;
	}

	/**
	 * How big the log is, without loading the project or scanning it twice (ask 160).
	 * Entries are the next seq. Chars are kept like lines; a log from before the
	 * count is summed once, then kept. GET /projects' 2-second wait needs this
	 * to stay a storage read: SUM(LENGTH(text)) over abso's log misses it.
	 */
	logSize(): { chars: number; entries: number } {
		const entries = this.next;
		const rows = this.storage.sql.exec("SELECT value FROM counts WHERE name = 'chars'").toArray() as {
			value: number;
		}[];
		if (rows[0] !== undefined) return { chars: rows[0].value, entries };
		if (entries === 0) return { chars: 0, entries: 0 };
		const summed = this.storage.sql.exec("SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM log").toArray()[0] as
			| { chars: number }
			| undefined;
		const chars = summed?.chars ?? 0;
		this.storage.sql.exec("INSERT OR REPLACE INTO counts (name, value) VALUES ('chars', ?)", chars);
		return { chars, entries };
	}

	/** Claim keys and deletes ever recorded (#46), kept like the line count; undefined before they were counted. */
	keyCount(): number | undefined {
		const rows = this.storage.sql.exec("SELECT value FROM counts WHERE name = 'keys'").toArray() as { value: number }[];
		return rows[0]?.value;
	}

	/**
	 * The lines and keys ever recorded, counting a log from before either count without loading the project
	 * (#46): one entry parsed at a time, so a log the load guard would refuse can still be measured. Kept once counted.
	 */
	countSizes(): { lines: number; keys: number } {
		const lines = this.lineCount();
		const keys = this.keyCount();
		if (lines !== undefined && keys !== undefined) return { lines, keys };
		let l = 0;
		let k = 0;
		for (const e of this.#entries()) {
			l += linesIn(e);
			k += keysIn(e);
		}
		this.#keep(lines === undefined ? l : undefined, keys === undefined ? k : undefined);
		return { lines: lines ?? l, keys: keys ?? k };
	}

	/** Stores the counts given. */
	#keep(lines: number | undefined, keys: number | undefined): void {
		if (lines !== undefined)
			this.storage.sql.exec("INSERT OR REPLACE INTO counts (name, value) VALUES ('lines', ?)", lines);
		if (keys !== undefined)
			this.storage.sql.exec("INSERT OR REPLACE INTO counts (name, value) VALUES ('keys', ?)", keys);
	}

	/** Every stored entry, in order. Rows are read one at a time, so loading never holds the whole log's text at once (#43). */
	*entries(): Iterable<Entry> {
		// A log from before the counts: counted as it loads, and kept.
		const countLines = this.lineCount() === undefined;
		const countKeys = this.keyCount() === undefined;
		let lines = 0;
		let keys = 0;
		for (const e of this.#entries()) {
			if (countLines) lines += linesIn(e);
			if (countKeys) keys += keysIn(e);
			yield e;
		}
		this.#keep(countLines ? lines : undefined, countKeys ? keys : undefined);
	}

	*#entries(from = 0): Iterable<Entry> {
		// A Workers cursor is iterable; a test's stand-in may only have toArray.
		const cursor = this.storage.sql.exec("SELECT seq, text FROM log WHERE seq >= ? ORDER BY seq, part", from) as {
			toArray(): unknown[];
		} & Partial<Iterable<unknown>>;
		const rows = (cursor[Symbol.iterator] ? cursor : cursor.toArray()) as Iterable<{ seq: number; text: string }>;
		let seq = -1;
		let text = "";
		for (const r of rows) {
			if (r.seq !== seq && seq >= 0) yield JSON.parse(text) as Entry;
			if (r.seq !== seq) text = "";
			seq = r.seq;
			text += r.text;
		}
		if (seq >= 0) yield JSON.parse(text) as Entry;
	}

	/**
	 * For backups (#29): the entries from seq `from` on as their stored JSON
	 * text (not parsed, so an export holds the project up as little as it
	 * can), at most `limit` of them and about 8 MB (always at least one), and
	 * the seq to ask for next, or null at the end.
	 */
	page(from: number, limit: number): { texts: string[]; next: number | null } {
		const rows = this.storage.sql
			.exec("SELECT seq, text FROM log WHERE seq >= ? AND seq < ? ORDER BY seq, part", from, from + limit)
			.toArray() as { seq: number; text: string }[];
		const texts: string[] = [];
		let seq = -1;
		let text = "";
		let size = 0;
		let next: number | null = null;
		for (const r of rows) {
			if (r.seq < from || r.seq >= from + limit) continue;
			if (r.seq !== seq && seq >= 0) {
				texts.push(text);
				size += text.length;
				if (size > 8_000_000) {
					next = r.seq;
					break;
				}
			}
			if (r.seq !== seq) text = "";
			seq = r.seq;
			text += r.text;
		}
		if (next === null && seq >= 0) texts.push(text);
		if (next === null && from + limit < this.next) next = from + limit;
		return { texts, next };
	}

	/** Up to `limit` entries from position `from`, parsed (#41: the feed and replay). */
	since(from: number, limit: number): Entry[] {
		const out: Entry[] = [];
		for (let at = from; out.length < limit; ) {
			const { texts, next } = this.page(at, limit - out.length);
			for (const t of texts) out.push(JSON.parse(t) as Entry);
			if (next === null || texts.length === 0) break;
			at = next;
		}
		return out;
	}

	/** Removes every entry: only for a restore whose log didn't load (#29). */
	clear(): void {
		const generation = this.generation() + 1;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM log");
			this.storage.sql.exec("DELETE FROM shapes");
			this.storage.sql.exec("DELETE FROM counts");
			this.storage.sql.exec("DELETE FROM marks WHERE name != ?", "generation");
			this.storage.sql.exec(
				"INSERT OR REPLACE INTO marks (name, value) VALUES (?, ?)",
				"generation",
				String(generation),
			);
		});
		this.next = 0;
	}

	/**
	 * Each version's changed files, kept between loads (#41, the Files pages):
	 * worked out from the log, never part of it, so an older Worker ignores
	 * the table and nothing about the project depends on it.
	 */
	shapes(): {
		get(space: string, version: number): string | undefined;
		put(space: string, version: number, value: string): void;
	} {
		const sql = this.storage.sql;
		return {
			get: (space, version) =>
				(
					sql.exec("SELECT value FROM shapes WHERE space = ? AND version = ?", space, version).toArray() as {
						value: string;
					}[]
				)[0]?.value,
			put: (space, version, value) =>
				void sql.exec("INSERT OR REPLACE INTO shapes (space, version, value) VALUES (?, ?, ?)", space, version, value),
		};
	}

	append(entries: readonly Entry[]): void {
		if (!entries.length) return;
		let next = this.next;
		this.storage.transactionSync(() => {
			const lines = entries.reduce((n, e) => n + linesIn(e), 0);
			if (lines > 0)
				this.storage.sql.exec(
					"INSERT INTO counts (name, value) VALUES ('lines', ?) ON CONFLICT(name) DO UPDATE SET value = value + ?",
					lines,
					lines,
				);
			// The newest version of shared: appended entries are the newest, so the last one that makes a version wins.
			for (const e of entries) {
				const v = sharedVersionOf(e);
				if (v !== undefined)
					this.storage.sql.exec("INSERT OR REPLACE INTO counts (name, value) VALUES ('shared', ?)", v);
				const last = lastPublishOf(e);
				if (last)
					this.storage.sql.exec(
						"INSERT OR REPLACE INTO marks (name, value) VALUES (?, ?)",
						"last",
						JSON.stringify(last),
					);
			}
			// Keys are only added to once counted: a log from before the key count is counted whole first (countSizes).
			const keys = entries.reduce((n, e) => n + keysIn(e), 0);
			if (keys > 0) this.storage.sql.exec("UPDATE counts SET value = value + ? WHERE name = 'keys'", keys);
			let chars = 0;
			for (const entry of entries) {
				const json = JSON.stringify(entry);
				logParts(json).forEach((text, part) => {
					chars += text.length;
					this.storage.sql.exec("INSERT INTO log (seq, part, text) VALUES (?, ?, ?)", next, part, text);
				});
				next++;
			}
			// Chars are only added to once counted: a log from before the count is summed whole first (logSize).
			if (chars > 0) this.storage.sql.exec("UPDATE counts SET value = value + ? WHERE name = 'chars'", chars);
			const generation = this.generation() + 1;
			this.storage.sql.exec(
				"INSERT OR REPLACE INTO marks (name, value) VALUES (?, ?)",
				"generation",
				String(generation),
			);
		});
		this.next = next;
	}
}

/** The engine's Project as the Worker's ProjectCalls; the clock comes from here. */
export class EngineProject implements ProjectCalls, ProjectHistory {
	blame(file: string, from?: number, to?: number, version?: number, draft?: string, agent?: string) {
		return blame(this.project, file, from, to, version, { ...(draft ? { draft } : {}), ...(agent ? { agent } : {}) });
	}
	folderBlame(folder: string, version?: number, draft?: string, agent?: string) {
		return folderBlame(this.project, folder, version, { ...(draft ? { draft } : {}), ...(agent ? { agent } : {}) });
	}
	tree(folder: string, version?: number, draft?: string | null, agent?: string, authors?: boolean) {
		return this.project.tree(folder, {
			...(version !== undefined ? { version } : {}),
			draft: draft ?? null,
			...(agent !== undefined ? { agent } : {}),
			...(authors ? { authors } : {}),
		});
	}
	pathLife(path: string, version?: number, draft?: string | null) {
		return this.project.pathLife(path, { ...(version !== undefined ? { version } : {}), draft: draft ?? null });
	}
	follow(path: string, version: number, from: number, to: number, at?: number, draft?: string | null) {
		return this.project.follow(path, version, from, to, { ...(at !== undefined ? { at } : {}), draft: draft ?? null });
	}
	pathsOf(agent: string) {
		return this.project.pathsOf(agent);
	}
	draftState(name: string) {
		return this.project.draftState(name);
	}
	collisions(file?: string, folder?: string) {
		return this.project.collisions({
			...(file !== undefined ? { file } : {}),
			...(folder !== undefined ? { folder } : {}),
		});
	}
	why(file: string, line: number, draft?: string, agent?: string) {
		return why(this.project, file, line, { ...(draft ? { draft } : {}), ...(agent ? { agent } : {}) });
	}
	where() {
		return where(this.project);
	}
	refusals(agent?: string, limit?: number) {
		return this.project.refusals({ ...(agent ? { agent } : {}), ...(limit !== undefined ? { limit } : {}) });
	}

	log(draft: string | null, limit?: number, path?: string, agent?: string, before?: number, follow?: boolean) {
		return this.project.log({
			draft,
			...(limit !== undefined ? { limit } : {}),
			...(path !== undefined ? { path } : {}),
			...(agent ? { agent } : {}),
			...(before !== undefined ? { before } : {}),
			...(follow ? { follow } : {}),
		});
	}
	fileAt(path: string, version: number, draft: string | null, agent?: string) {
		return this.project.fileAt(path, version, { draft, ...(agent ? { agent } : {}) });
	}
	compare(from: number, to: number, draft: string | null, agent?: string) {
		return this.project.compare(from, to, { draft, ...(agent ? { agent } : {}) });
	}
	show(version: number, draft: string | null, agent?: string) {
		return this.project.show(version, { draft, ...(agent ? { agent } : {}) });
	}
	diff(agent: string) {
		return this.project.diff(agent);
	}
	syncFull(agent: string, label?: string) {
		return this.project.sync(agent, { full: true, ...(label !== undefined ? { label } : {}) });
	}
	agentPaths(agent: string) {
		return this.project.agentPaths(agent);
	}
	pathsAt(version?: number, draft?: string | null) {
		return this.project.pathsAt(version, draft ?? null);
	}
	syncTo(agent: string, label: string) {
		return this.project.sync(agent, { label });
	}
	label(agent: string, name: string, version?: number, remove?: boolean) {
		return this.project.label(agent, name, version, Date.now(), { remove: remove === true });
	}
	labels() {
		return this.project.labels();
	}
	amend(agent: string, message: string) {
		return this.project.amend(agent, message, Date.now());
	}
	pluck(agent: string, draft: string, versions: number[], message: string, withDependencies?: boolean) {
		return this.project.pluck(agent, draft, versions, message, Date.now(), {
			withDependencies: withDependencies === true,
		});
	}
	drop(agent: string, versions: number[], message: string, withDependents?: boolean) {
		return this.project.drop(agent, versions, message, Date.now(), { withDependents: withDependents === true });
	}
	announce(agent: string, text: string, to?: string[], how?: string) {
		return this.project.announce(agent, text, to, Date.now(), how);
	}

	announcePerson(person: { id: string; name: string }, text: string, to?: string[]) {
		return this.project.announcePerson(person, text, to, Date.now());
	}
	starting(agent: string, text: string | null, files?: string[], options: { issue?: unknown; done?: unknown } = {}) {
		return this.project.starting(agent, text, files, Date.now(), options);
	}
	news(agent: string) {
		return this.project.news(agent);
	}
	restore(agent: string, files: string[] | null) {
		return this.project.restore(agent, files, Date.now());
	}

	private project: Project;

	/** Reads stored entries by log position, for the feed and replay (#41); absent, those answer 501. */
	private readonly read: ((from: number, limit: number) => Entry[]) | undefined;
	private readonly store: SqliteLog | undefined;

	constructor(project: Project, read?: (from: number, limit: number) => Entry[], store?: SqliteLog) {
		this.project = project;
		this.read = read;
		this.store = store;
	}

	/** The project's events from log position `from` (#41): reading consumes nothing. */
	feed(from: number, limit = 500) {
		if (!this.read) throw Object.assign(new Error("the feed needs the log"), { code: "not-implemented" });
		const end = this.project.logLength;
		const start = Math.max(0, Math.min(from, end));
		const entries = start < end ? this.read(start, Math.min(limit, end - start)) : [];
		// A drop event names the files it took out (#41), so a timeline needs no read per drop.
		const events = feedEvents(entries, start).map((e) => {
			if (e.type !== "drop" || e.version === undefined) return e;
			const v = this.project.log({ limit: 1, before: e.version + 1 }).versions[0];
			return v && v.version === e.version ? { ...e, dropped: v.files } : e;
		});
		return { next: start + entries.length, end, events };
	}

	/** The log position for a time (ms since 1970) or a version of shared (#41). */
	position(q: { time?: number; version?: number }) {
		return this.project.position(q);
	}
	/** Whether the Worker runs the queue's check; until it does, "queue": true does nothing. */
	setCheckerReady(ready: boolean): void {
		this.project.checkerReady = ready;
	}
	/** An agent withdraws what it has queued (#39). */
	unqueue(agent: string) {
		return this.project.unqueue(agent, Date.now());
	}
	/** The log length now: what a long-poll waits to see grow. */
	logLength() {
		return this.project.logLength;
	}
	/** An agent's draft diff for a reader: never creates the agent (#41). */
	diffOf(agent: string) {
		return this.project.diffOf(agent);
	}
	/** Every agent with unpublished changes: its files and how many changes (#41). */
	change(id: number) {
		return this.project.change(id);
	}

	changes(since: number, limit: number, before?: number, issue?: number) {
		return this.project.changes(since, limit, before, issue);
	}

	move(agent: string, from: string, to: string) {
		return this.project.move(agent, from, to, Date.now());
	}

	note(agent: string, body: Record<string, unknown>) {
		return this.project.note(agent, body, Date.now());
	}

	notePerson(person: { id: string; name: string }, body: Record<string, unknown>) {
		return this.project.notePerson(person, body, Date.now());
	}

	closeNotePerson(person: { id: string; name: string }, id: number, how: unknown) {
		return this.project.closeNotePerson(person, id, how, Date.now());
	}

	closeNote(agent: string, id: number, how: unknown) {
		return this.project.closeNote(agent, id, how, Date.now());
	}

	notes(options: { file?: string; change?: number; open?: boolean }) {
		return this.project.notes(options);
	}

	ribbon() {
		return this.project.ribbon();
	}

	drafts() {
		const s = this.project.status();
		return {
			version: s.version,
			drafts: s.agents
				.filter((a) => a.draftChanges > 0)
				.map((a) => ({ agent: a.agent, draft: a.draft, base: a.base, draftChanges: a.draftChanges, files: a.files })),
		};
	}
	/** The last copy replay loaded: scrubbing forward from it applies only the entries after it. */
	private replica: Project | undefined;

	/** The project as it stood with the first `at` log entries (#41, replay). */
	private at(at: number): Project {
		if (!this.read) throw Object.assign(new Error("replay needs the log"), { code: "not-implemented" });
		const n = Math.max(0, Math.min(at, this.project.logLength));
		const r = this.replica;
		if (r && r.logLength === n) return r;
		if (r && r.logLength < n) {
			r.catchUp(this.read(r.logLength, n - r.logLength));
			return r;
		}
		this.replica = Project.load(this.read(0, n), new MemoryStore());
		return this.replica;
	}
	statusAt(at: number) {
		const p = this.at(at);
		const answer = {
			at: Math.min(at, this.project.logLength),
			...(p.initialized ? p.status() : { version: -1, agents: [] }),
		};
		this.release();
		return answer;
	}
	whereAt(at: number) {
		const p = this.at(at);
		const answer = {
			at: Math.min(at, this.project.logLength),
			...(p.initialized ? where(p) : { version: -1, files: {} }),
		};
		this.release();
		return answer;
	}

	/**
	 * Drop the replay copy after each read (#46): a second copy of a large
	 * project's history doubles its memory, past a Durable Object's 128 MB.
	 * Each scrub replays from the start instead (about 0.2 s on game).
	 */
	private release(): void {
		this.replica = undefined;
	}

	/** hasBlob says whether the project holds a blob's bytes (#27); without it, every blob is refused. */
	/** whole stores and reads files kept whole (#46); without it every text file is tracked by line. */
	static open(
		storage: SqliteStorage,
		hasBlob?: (sha256: string) => boolean,
		whole?: { keep(text: string): string; read(sha: string): string | null },
	): EngineProject {
		const log = new SqliteLog(storage);
		return new EngineProject(
			Project.load(log.entries(), log, {
				...(hasBlob ? { hasBlob } : {}),
				...(whole ? { whole } : {}),
				now: () => Date.now(),
				shapes: log.shapes(),
				entryAt: (at) => log.since(at, 1)[0]!,
			}),
			(from, limit) => log.since(from, limit),
			log,
		);
	}

	exists() {
		return this.project.initialized;
	}
	/** Committed log epoch for host-side cache invalidation; it does not dispatch work. */
	committedGeneration(): number {
		return this.store?.generation() ?? 0;
	}
	init(
		files: Record<string, string>,
		modes?: Record<string, { exec?: boolean; link?: string | null }>,
		blobs?: Record<string, string>,
	) {
		return this.project.init(files, Date.now(), modes ?? {}, blobs ?? {});
	}
	edit(agent: string, body: EditBody) {
		return this.project.edit(agent, body as Parameters<Project["edit"]>[1], Date.now());
	}
	record(
		agent: string,
		files: Record<string, string | null>,
		modes?: Record<string, { exec?: boolean; link?: string | null }>,
		blobs?: Record<string, string>,
		meta?: { session?: string; subagent?: string; client?: string },
	) {
		return this.project.record(agent, files, Date.now(), modes ?? {}, blobs ?? {}, meta ?? {});
	}
	publish(agent: string, message: string, asIs?: boolean) {
		return this.project.publish(agent, message, Date.now(), { asIs: asIs === true });
	}
	sync(agent: string) {
		return this.project.sync(agent);
	}
	status() {
		return this.project.status();
	}
	switchTo(agent: string, name: string | null, carry = false) {
		return this.project.switchTo(agent, name, Date.now(), { carry });
	}
	land(agent: string, message: string) {
		return this.project.land(agent, message, Date.now());
	}
	ingest(input: Parameters<Project["ingest"]>[0], time: number) {
		return this.project.ingest(input, time);
	}
	syncDraft(agent: string) {
		return this.project.syncDraft(agent, Date.now());
	}
	filesAt(version: number) {
		return this.project.viewAt(version).files();
	}
	blobsAt(version: number) {
		return this.project.viewAt(version).blobs();
	}
	/**
	 * Shared's newest version. Its files and modes are laid out on first read: every call reads shared().version
	 * before and after its op, and laying out the files reads each file's text from the log, about 0.5 s on abso
	 * (abso 299).
	 */
	shared() {
		const version = this.project.version;
		const by = version > 0 ? this.project.published(version) : undefined;
		const blobs = this.project.blobs();
		const project = this.project;
		let files: Record<string, string> | undefined;
		let modes: ReturnType<Project["modes"]> | undefined;
		return {
			version,
			get files() {
				files ??= project.files();
				return files;
			},
			get modes() {
				modes ??= project.modes();
				return modes;
			},
			...(Object.keys(blobs).length > 0 ? { blobs } : {}),
			...(by ? { last: { agent: by.agent, message: by.message } } : {}),
		};
	}
}
