// Changes (#44): one start note, named draft or publish, its versions, and the list since you last
// looked. Writes (the record a publish joins) and reads go through ChangeHost; today the host is Project.

import type { Graph } from "../../src/engine/index.ts";
import type { PathIndex } from "./pathindex.ts";
import { ProjectError } from "./project-error.ts";
import type {
	AgentState,
	ChangeAnswer,
	ChangeRecord,
	Entry,
	NoteAnswer,
	NoteRecord,
	QueuedPublish,
	Starting,
} from "./project-types.ts";
import { last, type Space } from "./spaces.ts";

/** What the change reads and the record a publish joins need from a project. */
export interface ChangeHost {
	readonly changes: Map<number, ChangeRecord>;
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly spaces: ReadonlyMap<string, Space>;
	readonly notes: ReadonlyMap<number, NoteRecord>;
	readonly versionChange: Map<string, number>;
	readonly paths: Pick<PathIndex, "versionFiles">;
	readonly graph: Graph;
	stored(): number;
	shared(): Space;
	queue(): readonly QueuedPublish[];
	active(agent: AgentState, time: number): void;
	currentChange(agent: AgentState, time: number): number | undefined;
	liveNote(agent: AgentState): Starting | undefined;
	noteAnswer(n: NoteRecord): NoteAnswer;
	reviewersOf(files: readonly string[], id: number): { agent: string; files: string[]; read: boolean }[];
}

/** The files a version's changes name: cheap, for lists (the change page works out the net changes). */
export function namedFiles(graph: Graph, space: Space, version: number): string[] {
	const p = space.versions[version]!;
	return [...new Set([...p.atoms, ...(p.dropped ?? [])].flatMap((id) => graph.filesOf(id)))].toSorted();
}

export function changeRecord(
	host: ChangeHost,
	id: number,
	agent: AgentState,
	time: number,
	queuedNote?: Starting,
): ChangeRecord {
	let rec = host.changes.get(id);
	if (!rec) {
		const draft = [...host.spaces.values()].find((s) => s.startedAt === id)?.name ?? null;
		const noted =
			draft === null ? (queuedNote ?? (id === agent.noteAt && agent.starting ? agent.starting : undefined)) : undefined;
		rec = {
			id,
			agent: agent.name,
			kind: draft !== null ? "draft" : noted ? "note" : "publish",
			...(noted ? { note: { text: noted.text, files: [...noted.files] } } : {}),
			...(noted?.issue !== undefined ? { issue: noted.issue } : {}),
			draft,
			time: noted?.time ?? time,
			versions: [],
			settled: [],
			refusals: [],
			last: id,
		};
		host.changes.set(id, rec);
	}
	// A start note made later inside a named draft gives the draft's change its text.
	if (rec.kind === "draft" && !rec.note && agent.starting && agent.noteAt !== undefined && agent.noteAt > id) {
		rec.note = { text: agent.starting.text, files: [...agent.starting.files] };
		if (agent.starting.issue !== undefined) rec.issue = agent.starting.issue;
	}
	host.changes.set(id, rec);
	return rec;
}

/** A publish or land joins its change. Entries from before changes: the start note named it, and the publish ended the note. */
export function joinChange(
	host: ChangeHost,
	agent: AgentState,
	entry: Extract<Entry, { type: "publish" | "land" }>,
	at: number,
	draft: string | null,
	landed?: string,
): void {
	// A queued publish lands when the checker says so, not when the agent acts (#39).
	const queued =
		entry.type === "publish" && entry.queued !== undefined
			? host.queue().find((q) => q.id === entry.queued)
			: undefined;
	if (!queued) host.active(agent, entry.time);
	let id = entry.change;
	const old = id === undefined;
	if (id === undefined)
		id =
			landed !== undefined ? (host.spaces.get(landed)?.startedAt ?? at) : (host.currentChange(agent, entry.time) ?? at);
	const rec = changeRecord(host, id, agent, entry.time, queued?.note);
	rec.versions.push({ version: entry.version, draft, message: entry.message, time: entry.time, at });
	host.versionChange.set(`${draft ?? ""} ${entry.version}`, id);
	if (entry.type === "publish") for (const s of entry.settled ?? []) rec.settled.push({ ...s, version: entry.version });
	rec.last = at;
	host.changes.set(id, rec);
	if (old) {
		delete agent.starting;
		delete agent.noteAt;
	}
}

export function changeAnswer(host: ChangeHost, rec: ChangeRecord, withFiles: boolean): ChangeAnswer {
	const versions = rec.versions.map((v) => {
		const space = v.draft === null ? host.shared() : host.spaces.get(v.draft);
		const files =
			!space || v.version > last(space)
				? []
				: withFiles
					? host.paths.versionFiles(space, v.version)
					: namedFiles(host.graph, space, v.version);
		return { version: v.version, draft: v.draft, message: v.message, time: v.time, files };
	});
	const agent = host.agents.get(rec.agent);
	const open =
		rec.kind === "draft"
			? host.spaces.has(rec.draft!) && !rec.versions.some((v) => v.draft === null)
			: rec.kind === "note" && !!agent && agent.noteAt === rec.id && !!host.liveNote(agent);
	return {
		id: rec.id,
		agent: rec.agent,
		title: rec.note?.text ?? (rec.kind === "draft" ? `Draft ${rec.draft}` : (rec.versions[0]?.message ?? "")),
		kind: rec.kind,
		note: rec.note ? { text: rec.note.text, files: [...rec.note.files] } : null,
		issue: rec.issue ?? null,
		draft: rec.draft,
		time: rec.time,
		open,
		versions,
		files: [...new Set(versions.flatMap((v) => v.files))].toSorted(),
		settled: rec.settled.map((s) => ({ ...s })),
		refusals: rec.refusals.map(({ time, kinds, files }) => ({ time, kinds: [...kinds], files: [...files] })),
		notes: [...host.notes.values()].filter((n) => n.change === rec.id).map((n) => host.noteAnswer(n)),
		reviewers: host.reviewersOf(
			versions.flatMap((v) => v.files),
			rec.id,
		),
	};
}

/**
 * One change (#44): the start note, named draft or publish that began it,
 * each of its versions and the files they changed, what it settled, and its
 * refusals. `id` is the log position of the entry that began it.
 */
export function change(host: ChangeHost, id: number): ChangeAnswer {
	const rec = host.changes.get(id);
	if (!rec) throw new ProjectError("not-found", `there is no change ${String(id)}`);
	return changeAnswer(host, rec, true);
}

/**
 * "Since you last looked" (#44): the changes with anything new at or after
 * log position `since`, newest first, at most `limit`. Their files are the
 * ones their changes name; the change page has the net changes.
 */
export function changes(
	host: ChangeHost,
	since = 0,
	limit = 50,
	before?: number,
	issue?: number,
): { since: number; next: number; changes: ChangeAnswer[]; older?: number } {
	const noted = new Set([...host.notes.values()].filter((n) => n.change !== undefined).map((n) => n.change!));
	// `before` pages back (#44): changes whose newest entry is before that log position.
	// `issue` (#54): only the changes whose start note named it, begun or not.
	const found = [...host.changes.values()]
		.filter(
			(c) =>
				c.last >= since &&
				(before === undefined || c.last < before) &&
				(issue === undefined ? c.versions.length > 0 || c.refusals.length > 0 || noted.has(c.id) : c.issue === issue),
		)
		.toSorted((a, b) => b.last - a.last);
	const page = found.slice(0, Math.max(1, Math.min(limit, 200)));
	const older = found.length > page.length ? page[page.length - 1]!.last : undefined;
	return {
		since,
		next: host.stored(),
		changes: page.map((c) => changeAnswer(host, c, false)),
		...(older !== undefined ? { older } : {}),
	};
}
