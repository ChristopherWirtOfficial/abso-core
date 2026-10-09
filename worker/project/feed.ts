// The project's feed for readers (#41, the website): what happened, by log
// position, built from the log itself. An agent's `news` is a queue that
// reading empties; this reads the log, so any number of watchers can read it
// and nothing changes. Events carry who and what, never file contents, and
// news addressed to one agent shows only that it came, unless it's an
// announcement (which is sent to be read).
import type { Entry } from "./project.ts";

export interface FeedEvent {
	/** The entry's position in the log. */
	seq: number;
	type: Entry["type"];
	time?: number;
	agent?: string;
	/** The named draft, for a publish or switch there; null for shared. */
	draft?: string | null;
	version?: number;
	message?: string;
	/** Files a recording touched, a refusal named, or a starting note names. */
	files?: string[];
	/** A starting note's or an announcement's text. */
	text?: string;
	/** A refusal's collision kinds; a publish's settles (file, kept, whose version). */
	kinds?: string[];
	settled?: { file: string; kept: string; theirs: { agent: string; version: number } }[];
	/** How many marker blocks a sync wrote, and how many news items reached an agent. */
	blocks?: number;
	items?: number;
	/** A label's name, and whether it was taken off (#43, the website's timeline). */
	label?: string;
	remove?: boolean;
	/** The versions a drop took out: those asked for and their dependents. */
	drops?: number[];
	/** The files the drop's version changed (added by the Worker, which has the project). */
	dropped?: string[];
	/** A note's id (#44), its kind (comment, objection, read), the note it answers, its change, and how it was closed. */
	note?: number;
	noteKind?: string;
	reply?: number;
	change?: number;
	how?: string;
	/** The merge queue's id (#39), for a queued or pulled publish, and why it was pulled. */
	queued?: number;
	reason?: string;
}

const ANNOUNCED = /^Announcement from /;

/** The events for log entries `entries`, the first of which is at position `from`. */
export function feedEvents(entries: readonly Entry[], from: number): FeedEvent[] {
	return entries.map((e, i) => event(e, from + i));
}

function event(e: Entry, seq: number): FeedEvent {
	const base = { seq, type: e.type, ...("time" in e && typeof e.time === "number" ? { time: e.time } : {}) };
	switch (e.type) {
		case "init":
			return { ...base, time: e.time, version: 0, files: [...new Set(e.atom.inserts.map((r) => r.file))].sort() };
		case "draft":
			return {
				...base,
				time: e.atom.time,
				agent: e.agent,
				files: [...new Set(e.atom.inserts.map((r) => r.file).filter(Boolean))].sort(),
			};
		case "publish":
			return {
				...base,
				agent: e.agent,
				draft: e.space ?? null,
				version: e.version,
				message: e.message,
				...(e.settled ? { settled: e.settled.map((s) => ({ file: s.file, kept: s.kept, theirs: s.theirs })) } : {}),
			};
		case "land":
			return { ...base, agent: e.agent, draft: null, version: e.version, message: e.message };
		case "sync":
		case "join":
			return { ...base, agent: e.agent, version: e.version };
		case "switch":
			return { ...base, agent: e.agent, draft: e.space === "" ? null : e.space, version: e.version };
		case "discard":
			return {
				...base,
				agent: e.agent,
				...(e.markers ? { blocks: e.markers.length, files: [...new Set(e.markers.map((m) => m.file))].sort() } : {}),
			};
		case "refused":
			return {
				...base,
				agent: e.agent,
				kinds: [...new Set(e.collisions.map((c) => c.kind))].sort(),
				files: [...new Set(e.collisions.map((c) => c.file))].sort(),
			};
		case "starting":
			return { ...base, agent: e.agent, ...(e.text !== null ? { text: e.text, files: [...(e.files ?? [])] } : {}) };
		case "news": {
			// Announcements are meant to be read; other news is the agent's own.
			const said = e.text.filter((t) => ANNOUNCED.test(t));
			return {
				...base,
				agent: e.agent,
				items: e.pairs.length,
				...(said.length > 0 && said.length === e.text.length ? { text: said.join("\n") } : {}),
			};
		}
		case "note":
			return {
				...base,
				agent: e.agent,
				note: e.id,
				noteKind: e.kind,
				files: [e.file],
				text: e.text,
				...(e.reply !== undefined ? { reply: e.reply } : {}),
				...(e.change !== undefined ? { change: e.change } : {}),
			};
		case "note-closed":
			return { ...base, agent: e.agent, note: e.id, how: e.how };
		case "queued":
			return { ...base, agent: e.agent, queued: e.id, message: e.message, items: e.changes.length };
		case "pulled":
			return { ...base, queued: e.id, reason: e.reason };
		case "label":
			return { ...base, agent: e.agent, version: e.version, label: e.name, ...(e.remove ? { remove: true } : {}) };
		case "drop":
			return { ...base, agent: e.agent, version: e.version, message: e.message, drops: [...e.versions] };
		case "amend":
		case "space":
		case "space-sync":
			return {
				...base,
				agent: e.agent,
				...("version" in e ? { version: e.version } : {}),
				...("message" in e ? { message: e.message } : {}),
			};
		default:
			return { ...base, ...("agent" in e ? { agent: (e as { agent: string }).agent } : {}) };
	}
}
