// Apply one log entry to the project's in-memory state. Writes go through
// ApplyEntryHost; today the host is Project. Membership (which atoms are in
// which space) is applied first, in spaces.ts.

import type { AtomId, Graph } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import type {
	AgentState,
	ChangeRecord,
	Entry,
	NoteRecord,
	QueuedPublish,
	Refusal,
	TellRecord,
} from "./project-types.ts";
import { SHARED, type Space } from "./spaces.ts";

/** What applying one log entry needs from a project. */
export interface ApplyEntryHost {
	readonly graph: Graph;
	readonly agents: Map<string, AgentState>;
	readonly atomAt: number[];
	readonly mods: string[];
	readonly notes: Map<number, NoteRecord>;
	readonly changes: Map<number, ChangeRecord>;
	readonly labels: Map<string, number[]>;
	readonly refusals: Refusal[];
	/** The newest tells, by id in the order sent, at most TELLS_KEPT. */
	readonly tells: Map<number, TellRecord>;
	uncheck(id: number): void;
	stamp(time: number | undefined): void;
	applyMembership(entry: Entry, at: number): void;
	agentOf(name: string): AgentState;
	active(agent: AgentState, time: number): void;
	joinChange(
		agent: AgentState,
		entry: Extract<Entry, { type: "publish" | "land" }>,
		at: number,
		draft: string | null,
		landed?: string,
	): void;
	space(name: string): Space;
	queued(): QueuedPublish[];
	setQueued(items: QueuedPublish[]): void;
	setQueuedId(id: number): void;
	queuedId(): number;
	setLastNote(id: number): void;
	lastNote(): number;
	setAnnounced(n: number): void;
	announced(): number;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	spaceOf(agent: AgentState): Space;
	draft(agent: AgentState): AtomId[];
	currentChange(agent: AgentState, time: number): number | undefined;
	changeRecord(id: number, agent: AgentState, time: number): ChangeRecord;
}

/**
 * Apply one log entry at position `at`. `time` is the entry's time when it
 * has one, used for news that was logged before every item carried its own.
 */
export function applyEntry(host: ApplyEntryHost, entry: Entry, at: number, time: number | undefined): void {
	const stamped = entry.type === "draft" ? entry.atom.time : "time" in entry ? entry.time : undefined;
	host.stamp(stamped);
	// Which atoms are in which space at which version: kept in spaces.ts, the same rules the tables use.
	host.applyMembership(entry, at);
	switch (entry.type) {
		case "init": {
			host.atomAt[entry.atom.seq] = at;
			host.graph.add(entry.atom);
			break;
		}
		case "join":
			host.agents.set(entry.agent, {
				name: entry.agent,
				space: SHARED,
				base: entry.version,
				synced: false,
				mine: [],
				news: [],
				newsAt: [],
				told: new Set(),
				parked: new Map(),
				marked: [],
				joined: at,
			});
			break;
		case "draft": {
			host.atomAt[entry.atom.seq] = at;
			host.graph.add(entry.atom);
			const agent = host.agentOf(entry.agent);
			host.active(agent, entry.atom.time);
			agent.mine.push(entry.atom.id);
			agent.lastEdit = {
				time: entry.atom.time,
				...(entry.session ? { session: entry.session } : {}),
				...(entry.client ? { client: entry.client } : {}),
			};
			if (entry.client?.startsWith("avcs-mod/") && !host.mods.includes(entry.client)) host.mods.push(entry.client);
			break;
		}
		case "publish": {
			host.atomAt[entry.tie.seq] = at;
			host.graph.add(entry.tie);
			const space = host.space(entry.space ?? SHARED);
			const agent = host.agentOf(entry.agent);
			if (entry.rebase) {
				agent.base = entry.version;
				agent.mine = [];
			} else {
				agent.mine.push(entry.tie.id);
			}
			host.joinChange(agent, entry, at, space.name === SHARED ? null : space.name);
			agent.marked = agent.marked.filter((r) => r.space !== (entry.space ?? SHARED));
			delete agent.held;
			if (entry.queued !== undefined) host.setQueued(host.queued().filter((q) => q.id !== entry.queued));
			break;
		}
		case "queued": {
			const agent = host.agentOf(entry.agent);
			host.active(agent, entry.time);
			host.queued().push({
				id: entry.id,
				agent: entry.agent,
				message: entry.message,
				time: entry.time,
				changes: [...entry.changes],
				resolves: [...entry.resolves],
				...(entry.settled ? { settled: entry.settled } : {}),
				...(entry.change !== undefined ? { change: entry.change } : {}),
				...(entry.change !== undefined && entry.change === agent.noteAt && agent.starting
					? { note: agent.starting }
					: {}),
			});
			host.setQueuedId(Math.max(host.queuedId(), entry.id));
			// Its markers were settled when it was queued; what it kept goes out when it lands.
			agent.marked = agent.marked.filter((r) => r.space !== SHARED);
			break;
		}
		case "note": {
			if (!entry.person) host.agentOf(entry.agent);
			const { type: _, ...note } = entry;
			host.notes.set(entry.id, { ...note, lines: [...entry.lines], at });
			host.setLastNote(Math.max(host.lastNote(), entry.id));
			if (entry.change !== undefined) {
				const change = host.changes.get(entry.change);
				if (change) {
					change.last = at;
					host.changes.set(entry.change, change);
				}
			}
			break;
		}
		case "note-closed": {
			const note = host.notes.get(entry.id);
			if (note) {
				note.closed = { agent: entry.agent, how: entry.how, time: entry.time };
				host.notes.set(entry.id, note);
			}
			break;
		}
		case "pulled":
			host.setQueued(host.queued().filter((q) => q.id !== entry.id));
			host.uncheck(entry.id);
			break;
		case "starting": {
			const agent = host.agentOf(entry.agent);
			host.active(agent, entry.time);
			if (entry.text === null) {
				delete agent.starting;
				delete agent.noteAt;
			} else {
				agent.starting = {
					text: entry.text,
					files: [...(entry.files ?? [])],
					time: entry.time,
					...(entry.issue !== undefined ? { issue: entry.issue } : {}),
				};
				agent.noteAt = at;
			}
			break;
		}
		case "sync": {
			const agent = host.agentOf(entry.agent);
			agent.base = entry.version;
			agent.synced = true;
			// The version it moved to: the newest, or an older one with a label.
			const set = host.at(host.spaceOf(agent), entry.version);
			agent.mine = agent.mine.filter((id) => !set.has(id));
			break;
		}
		case "news": {
			const agent = host.agentOf(entry.agent);
			agent.news.push(...entry.text);
			agent.newsAt.push(...entry.text.map(() => time));
			entry.pairs.forEach((p, i) => {
				agent.told.add(p);
				if (!p.startsWith("announce ")) return;
				const id = Number(p.slice(9)) || 0;
				host.setAnnounced(Math.max(host.announced(), id));
				tellSent(host.tells, id, entry.text[i] ?? entry.text[0] ?? "", agent.name, time);
			});
			break;
		}
		case "discard": {
			const agent = host.agentOf(entry.agent);
			const gone = new Set(entry.atoms);
			agent.mine = agent.mine.filter((id) => !gone.has(id));
			if (entry.markers) agent.marked.push(...entry.markers.map((r) => ({ ...r, space: agent.space })));
			break;
		}
		case "heard": {
			const agent = host.agentOf(entry.agent);
			// A sync's stale heard keeps announcements, so it hears no tell.
			if (entry.stale !== true)
				for (const tell of host.tells.values())
					if (tell.heard.get(agent.name) === null) tell.heard.set(agent.name, { at: time });
			const keep = agent.news.map((t) => entry.stale === true && t.startsWith("Announcement from "));
			agent.news = agent.news.filter((_, i) => keep[i]);
			agent.newsAt = agent.newsAt.filter((_, i) => keep[i]);
			break;
		}
		case "drop": {
			const gone = new Set(entry.atoms);
			// Agents keep their own published-but-unsynced atoms in `mine`; dropped ones leave.
			for (const agent of host.agents.values()) {
				agent.mine = agent.mine.filter((id) => !gone.has(id));
				for (const p of agent.parked.values()) p.mine = p.mine.filter((id) => !gone.has(id));
			}
			break;
		}
		case "label": {
			const list = (host.labels.get(entry.name) ?? []).filter((v) => v !== entry.version);
			if (!entry.remove) list.push(entry.version);
			list.sort((a, b) => a - b);
			if (list.length > 0) host.labels.set(entry.name, list);
			else host.labels.delete(entry.name);
			break;
		}
		case "refused":
			host.refusals.push({
				agent: entry.agent,
				draft: entry.space ?? null,
				via: entry.via,
				time: entry.time,
				collisions: entry.collisions.map((c) => ({ ...c })),
				...(entry.message ? { message: entry.message } : {}),
			});
			{
				// On the change the agent was working on, when there is one (#44).
				const agent = host.agentOf(entry.agent);
				host.active(agent, entry.time);
				const id = host.currentChange(agent, entry.time);
				const refusal = {
					at,
					time: entry.time,
					kinds: [...new Set(entry.collisions.map((c) => c.kind))].sort(),
					files: [...new Set(entry.collisions.map((c) => c.file))].sort(),
					...(entry.message ? { message: entry.message } : {}),
				};
				if (id !== undefined) {
					const rec = host.changeRecord(id, agent, entry.time);
					rec.refusals.push({ ...refusal, files: [...refusal.files], kinds: [...refusal.kinds] });
					rec.last = at;
					host.changes.set(id, rec);
				}
				// Kept until it pushes: the settle tells the held push's reason, and its change lists the refusal.
				if (entry.via === "publish")
					agent.held = [...(agent.held ?? []), { ...refusal, ...(id !== undefined ? { change: id } : {}) }];
			}
			break;
		case "switch": {
			const agent = host.agentOf(entry.agent);
			const carry = entry.carry ?? true;
			const draft = host.draft(agent);
			const carried = new Set(carry ? draft : []);
			agent.parked.set(agent.space, { base: agent.base, mine: agent.mine.filter((id) => !carried.has(id)) });
			const back = carry ? undefined : agent.parked.get(entry.space);
			agent.parked.delete(entry.space);
			agent.space = entry.space;
			agent.base = back ? back.base : entry.version;
			agent.mine = back ? back.mine : [...carried];
			agent.synced = true;
			break;
		}
		case "land": {
			host.atomAt[entry.tie.seq] = at;
			host.graph.add(entry.tie);
			host.joinChange(host.agentOf(entry.agent), entry, at, null, entry.space);
			break;
		}
		case "amend":
		case "space":
		case "space-sync":
			// Membership only: Membership.apply has done it.
			break;
		default: {
			// A kind this engine doesn't know was written by a newer one. Skipping
			// it would show, and then build on, a project without that entry, so
			// the load stops instead.
			const kind = (entry as { type?: unknown }).type;
			throw new ProjectError(
				"unknown-entry",
				`log entry ${String(at)} is of kind ${JSON.stringify(kind)}, which this version of abso doesn't know: a newer version wrote it, so this one won't load the project`,
			);
		}
	}
}

/** How many tells the project keeps who-heard-what for (status's tells). */
export const TELLS_KEPT = 50;

/** A tell's news reached one recipient's queue: the tell is kept, the oldest dropped past TELLS_KEPT. */
function tellSent(
	tells: Map<number, TellRecord>,
	id: number,
	text: string,
	agent: string,
	time: number | undefined,
): void {
	let tell = tells.get(id);
	if (tell === undefined) {
		tell = { id, text, at: time, heard: new Map() };
		tells.set(id, tell);
		for (const old of tells.keys()) {
			if (tells.size <= TELLS_KEPT) break;
			tells.delete(old);
		}
	}
	if (!tell.heard.has(agent)) tell.heard.set(agent, null);
}
