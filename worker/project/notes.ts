// Notes on lines and review areas (#44): where a note's lines are now and what that makes it, who
// reviews which files by avcs.json, the notes list, every agent's start note, and writing or closing
// a note. Reads go through NoteHost, writes through NoteWriteHost; today the host is Project.

import type { AtomId, Graph, LineId, View } from "../../src/engine/index.ts";
import { matchesPattern } from "./globs.ts";
import { type NewsItem, noteClosedItem, noteSaid } from "./news.ts";
import { checkReadPath } from "./path-rules.ts";
import { ProjectError } from "./project-error.ts";
import type {
	AgentState,
	ChangeRecord,
	Entry,
	NoteAnswer,
	NoteBody,
	NoteRecord,
	PersonSender,
	Starting,
} from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What the note reads need from a project. */
export interface NoteHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly spaces: ReadonlyMap<string, Space>;
	readonly notes: ReadonlyMap<number, NoteRecord>;
	initialized(): boolean;
	shared(): Space;
	sharedView(): View;
	spellingIn(view: View, path: string): string;
	viewAt(space: Space, version: number): View;
	agentView(agent: AgentState): View;
	view(set: ReadonlySet<AtomId>): View;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	liveNote(agent: AgentState): Starting | undefined;
}

/** What writing or closing a note needs from a project. */
export interface NoteWriteHost {
	readonly notes: Map<number, NoteRecord>;
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly changes: ReadonlyMap<number, ChangeRecord>;
	readonly graph: Graph;
	lastNote(): number;
	agentView(agent: AgentState): View;
	viewAtVersion(version: number): View;
	sharedView(): View;
	changeOfLines(lines: readonly LineId[]): number | undefined;
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
	queueNews(agent: AgentState, items: NewsItem[], entries: Entry[]): void;
	noteAnswer(n: NoteRecord): NoteAnswer;
}

export interface ReviewRule {
	readonly paths: string[];
	readonly reviewer: string;
}

/** The project's reviewers per area: avcs.json's `"review": [{"paths": [...], "reviewer": "..."}]`. */
export function reviewRulesIn(avcsJson: string | undefined): ReviewRule[] {
	if (avcsJson === undefined) return [];
	let review: unknown;
	try {
		review = (JSON.parse(avcsJson) as { review?: unknown }).review;
	} catch {
		return [];
	}
	if (!Array.isArray(review)) return [];
	return review.flatMap((r) => {
		const { paths, reviewer } = (r ?? {}) as { paths?: unknown; reviewer?: unknown };
		return Array.isArray(paths) &&
			paths.every((p) => typeof p === "string") &&
			typeof reviewer === "string" &&
			reviewer !== ""
			? [{ paths: paths as string[], reviewer }]
			: [];
	});
}

/** Each reviewer whose area these files fall in, the files that do, and whether it has noted the change. */
export function reviewersOf(
	rules: readonly ReviewRule[],
	files: readonly string[],
	hasNoted: (agent: string) => boolean,
): { agent: string; files: string[]; read: boolean }[] {
	const out = new Map<string, Set<string>>();
	for (const rule of rules) {
		const matched = files.filter((f) => rule.paths.some((p) => matchesPattern(p, f)));
		if (matched.length === 0) continue;
		const set = out.get(rule.reviewer) ?? new Set<string>();
		for (const f of matched) set.add(f);
		out.set(rule.reviewer, set);
	}
	return [...out]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([agent, set]) => ({ agent, files: [...set].sort(), read: hasNoted(agent) }));
}

/** A note as reads show it, from the view its lines live in (undefined when no space holds them any more). */
export function noteAnswerIn(n: NoteRecord, view: View | undefined): NoteAnswer {
	// Where the lines are now, found by their ids: a move (#49) can have taken them to another file.
	let lines: [number, number] | null = null;
	let file = n.file;
	if (view) {
		const found: { file: string; at: number }[] = [];
		for (const id of n.lines) {
			const f = view.fileOf(id);
			const at = view.lineNumber(f, id);
			if (at >= 0) found.push({ file: f, at: at + 1 });
		}
		if (found.length > 0) {
			file = found[0]!.file;
			const at = found.filter((x) => x.file === file).map((x) => x.at);
			lines = [Math.min(...at), Math.max(...at)];
		}
	}
	const state = n.closed ? n.closed.how : lines !== null ? "open" : n.kind === "objection" ? "addressed" : "outdated";
	return {
		id: n.id,
		agent: n.agent,
		kind: n.kind,
		file,
		lines,
		text: n.text,
		change: n.change ?? null,
		reply: n.reply ?? null,
		time: n.time,
		state,
		...(n.person ? { person: { ...n.person.person } } : {}),
	};
}

/**
 * The view a note's lines live in (#44; Git Lessons' review, 2026-10-07):
 * shared once any were published there; else the named draft they were
 * published into; else their author's draft, where it works now or where it
 * parked it. Undefined when no space holds them any more (a discarded draft).
 */
export function noteView(host: NoteHost, n: NoteRecord): View | undefined {
	const writers = new Set(n.lines.map((l) => host.graph.lineAtom(l)).filter((a): a is AtomId => a !== undefined));
	const holds = (set: ReadonlySet<AtomId> | readonly AtomId[]) =>
		[...writers].some((a) => (set instanceof Set ? set.has(a) : (set as readonly AtomId[]).includes(a)));
	if (holds(host.shared().own)) return host.sharedView();
	for (const space of host.spaces.values())
		if (space !== host.shared() && holds(space.own)) return host.viewAt(space, last(space));
	const first = [...writers][0];
	const author = first === undefined ? undefined : host.agents.get(host.graph.atom(first).author);
	if (!author) return undefined;
	if (holds(author.mine)) return host.agentView(author);
	for (const [name, parked] of author.parked) {
		const space = host.spaces.get(name);
		if (space && holds(parked.mine)) return host.view(new Set([...host.at(space, parked.base), ...parked.mine]));
	}
	return undefined;
}

export function noteAnswer(host: NoteHost, n: NoteRecord): NoteAnswer {
	return noteAnswerIn(n, noteView(host, n));
}

/** Notes, oldest first: on a file, on a change, or only the ones still open. */
export function notes(
	host: NoteHost,
	options: { file?: string; change?: number; open?: boolean } = {},
): { notes: NoteAnswer[] } {
	// Any spelling reads the stored one (#41, F7).
	const file =
		options.file === undefined || !host.initialized() ? options.file : host.spellingIn(host.sharedView(), options.file);
	const out = [...host.notes.values()]
		.filter((n) => options.change === undefined || n.change === options.change)
		.map((n) => ({ n, a: noteAnswer(host, n) }))
		.filter(({ n, a }) => file === undefined || a.file === file || n.file === file)
		.map(({ a }) => a)
		.filter((n) => !options.open || n.state === "open");
	return { notes: out };
}

/** Every agent's starting note, by agent name. */
export function startingNotes(
	host: NoteHost,
): { agent: string; draft: string | null; text: string; files: string[]; time: number }[] {
	return [...host.agents.values()]
		.filter((a) => host.liveNote(a))
		.toSorted((a, b) => (a.name < b.name ? -1 : 1))
		.map((a) => {
			const note = host.liveNote(a)!;
			return { agent: a.name, draft: a.space === SHARED ? null : a.space, ...note, files: [...note.files] };
		});
}

export function writeNote(
	host: NoteWriteHost,
	entries: Entry[],
	writerOf: () => { name: string; person?: PersonSender },
	body: NoteBody,
	time: number,
): { id: number; change: number | null; lines: [number, number] } {
	const text = body.text;
	if (typeof text !== "string" || text.trim() === "") throw new ProjectError("bad-request", "a note needs {text}");
	if (text.length > 4000) throw new ProjectError("bad-request", "a note is at most 4000 characters");
	const kind = body.kind ?? "comment";
	if (kind !== "comment" && kind !== "objection" && kind !== "read")
		throw new ProjectError("bad-request", "kind is comment, objection or read");
	let file: string;
	let lines: LineId[];
	let change: number | undefined;
	let reply: number | undefined;
	if (body.reply !== undefined) {
		const parent = Number.isInteger(body.reply) ? host.notes.get(body.reply as number) : undefined;
		if (!parent) throw new ProjectError("not-found", `there is no note ${String(body.reply)}`);
		reply = parent.reply ?? parent.id;
		({ file, change } = parent);
		lines = [...parent.lines];
	} else {
		if (typeof body.file !== "string")
			throw new ProjectError("bad-request", "a note needs {file, from, to}, or {reply}");
		file = body.file;
		checkReadPath(file);
		let view: View;
		if (typeof body.of === "string") {
			const of = host.agents.get(body.of);
			if (!of) throw new ProjectError("not-found", `there is no agent ${JSON.stringify(body.of)}`);
			view = host.agentView(of);
		} else if (body.version !== undefined) {
			view = host.viewAtVersion(body.version as number);
		} else {
			view = host.sharedView();
		}
		if (!view.hasFile(file)) throw new ProjectError("not-found", `there is no ${file} there`);
		const shown = view.lines(file);
		const from = body.from ?? 1;
		const to = body.to ?? from;
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			(from as number) < 1 ||
			(to as number) < (from as number) ||
			(to as number) > shown.length
		) {
			throw new ProjectError("bad-request", `from and to are line numbers in ${file}, 1 to ${shown.length}`);
		}
		if ((to as number) - (from as number) >= 500)
			throw new ProjectError("bad-request", "a note covers at most 500 lines");
		lines = shown.slice((from as number) - 1, to as number).map((l) => l.id);
		change = host.changeOfLines(lines);
	}
	const writer = writerOf();
	const id = host.lastNote() + 1;
	const entry: Entry = {
		type: "note",
		id,
		agent: writer.name,
		kind,
		file,
		lines,
		text: text.trim(),
		...(change !== undefined ? { change } : {}),
		...(reply !== undefined ? { reply } : {}),
		time,
		...(writer.person ? { person: writer.person } : {}),
	};
	entries.push(entry);
	host.apply(entry);
	const note = host.notes.get(id)!;
	const where = host.noteAnswer(note).lines;
	if (kind !== "read") {
		const rec = change !== undefined ? host.changes.get(change) : undefined;
		const hearers = new Set<string>();
		for (const l of lines) {
			const info = host.graph.line(l);
			if (info) hearers.add(host.graph.atom(info.atom).author);
		}
		if (rec) hearers.add(rec.agent);
		if (reply !== undefined)
			for (const n of host.notes.values()) if (n.id === reply || n.reply === reply) hearers.add(n.agent);
		hearers.delete(writer.name);
		const said = noteSaid({
			id,
			writer: writer.name,
			...(writer.person ? { person: writer.person } : {}),
			kind,
			reply: reply !== undefined,
			file,
			where,
			...(rec ? { change: rec.note?.text ?? rec.versions[0]?.message ?? "" } : {}),
			text: text.trim(),
		});
		for (const name of [...hearers].toSorted()) {
			const a = host.agents.get(name);
			if (a) host.queueNews(a, [{ key: `note ${id}`, text: said }], entries);
		}
	}
	host.flush(entries);
	return { id, change: change ?? null, lines: where ?? [0, 0] };
}

/** Close a note: only its writer can (#44). */
export function closeNote(
	host: NoteWriteHost,
	agentName: string,
	id: number,
	how: unknown,
	time: number,
	person?: PersonSender,
): NoteAnswer {
	const note = Number.isInteger(id) ? host.notes.get(id) : undefined;
	if (!note) throw new ProjectError("not-found", `there is no note ${String(id)}`);
	if (how !== "resolved" && how !== "withdrawn") throw new ProjectError("bad-request", "how is resolved or withdrawn");
	if (note.agent !== agentName)
		throw new ProjectError("conflict", `only ${note.agent}, who wrote note ${id}, can close it`);
	if (note.closed) return host.noteAnswer(note);
	const entries: Entry[] = [];
	const entry: Entry = { type: "note-closed", id, agent: agentName, how, time, ...(person ? { person } : {}) };
	entries.push(entry);
	host.apply(entry);
	const rec = note.change !== undefined ? host.changes.get(note.change) : undefined;
	if (rec && rec.agent !== agentName && note.kind === "objection") {
		const a = host.agents.get(rec.agent);
		if (a) host.queueNews(a, [noteClosedItem(agentName, how, id, note)], entries);
	}
	host.flush(entries);
	return host.noteAnswer(note);
}
