// How news reads: one sentence for each thing an agent should hear, with the key that makes it heard
// once, and who hears it after an edit, publish or land. Writes (the news entry) stay on Project.

import { type AtomId, type Graph, isStartNode, parseKey, type View } from "../../src/engine/index.ts";
import { unionOverlay } from "../../src/engine/state-source.ts";
import { type Origin, type Pair, pairsIn, touchedFiles } from "./collisions.ts";
import { type DefinitionCollision, signature } from "./definition-rule.ts";
import { definitionsIn } from "./definitions.ts";
import type { Kept } from "./markers.ts";
import { pairKey } from "./project-helpers.ts";
import type { AgentState, Collision, Entry, NoteKind, Overlap, PersonSender, Settled } from "./project-types.ts";
import { last, type Space } from "./spaces.ts";

/** One piece of news: `key` is told to an agent once, `text` is what it reads. */
export interface NewsItem {
	readonly key: string;
	readonly text: string;
}

/** A line quoted in news: trimmed, and cut to 80 characters. */
export function clip(line: string): string {
	const t = line.trim();
	return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

function versionName(o: { version: number; draft?: string }): string {
	return o.draft === undefined ? `version ${o.version}` : `draft ${o.draft}, version ${o.version}`;
}

export function agentAnnouncement(sender: string, mark: string, text: string): string {
	return `Announcement from ${sender} (${mark}): ${text.trim()}`;
}

export function personAnnouncement(name: string, id: string, text: string): string {
	return `Announcement from ${name} (a person, signed in on the website, id ${id}): ${JSON.stringify(text.trim())}`;
}

/** A reviewer hears of a change that touches its review area (#44). */
export function reviewItem(
	by: string,
	change: number,
	title: string,
	files: readonly string[],
	version: number,
): NewsItem {
	const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` and ${files.length - 3} more` : "");
	return {
		key: `review ${change}`,
		text: `${by}'s change "${clip(title)}" touches ${shown} (version ${version}), in your review area. Read it: abso review ${change}.`,
	};
}

/** An objection's writer hears that a version changed every line it was on (#44). */
export function addressedItem(
	by: string,
	version: number,
	note: { readonly id: number; readonly file: string; readonly text: string },
): NewsItem {
	return {
		key: `addressed ${note.id}`,
		text: `${by}'s version ${version} changed every line your objection ${note.id} on ${note.file} was on ("${clip(note.text)}"). Look, then close it: abso note --close ${note.id} --resolved.`,
	};
}

/**
 * A note's lines' authors, its change's agent and its thread hear it (#44).
 * A person's text is JSON-quoted, as in their announcements, so a line break
 * can't pass for another item.
 */
export function noteSaid(note: {
	readonly id: number;
	readonly writer: string;
	readonly person?: PersonSender;
	readonly kind: NoteKind;
	readonly reply: boolean;
	readonly file: string;
	readonly where: readonly [number, number] | null;
	readonly change?: string;
	readonly text: string;
}): string {
	const { id, file, where } = note;
	const span = where
		? where[0] === where[1]
			? `line ${where[0]}`
			: `lines ${where[0]}-${where[1]}`
		: "lines now gone";
	const about = note.change !== undefined ? ` (change "${clip(note.change)}")` : "";
	const verb = note.reply ? "replies on" : note.kind === "objection" ? "objects on" : "comments on";
	const ask =
		note.kind === "objection" ? ` Fix it, or answer: abso note --reply ${id}` : ` Answer: abso note --reply ${id}`;
	return note.person
		? `${note.person.person.name} (a person, signed in on the website, id ${note.person.person.id}) ${verb} ${file} ${span}${about}: ${JSON.stringify(clip(note.text))}.${ask}`
		: `${note.writer} ${verb} ${file} ${span}${about}: "${clip(note.text)}".${ask}`;
}

/** A change's agent hears that an objection on it was closed (#44). */
export function noteClosedItem(
	by: string,
	how: "resolved" | "withdrawn",
	id: number,
	note: { readonly file: string; readonly text: string },
): NewsItem {
	return {
		key: `note closed ${id}`,
		text: `${by} ${how === "resolved" ? "resolved" : "withdrew"} its objection on ${note.file}: "${clip(note.text)}".`,
	};
}

/** An agent with work in files another's starting note names (#37). */
export function startingItem(by: string, time: number, to: string, text: string, files: readonly string[]): NewsItem {
	return {
		key: `starting ${by} ${time} ${to}`,
		text: `${by} says it is starting on "${text.trim()}", naming ${files.join(", ")}, where you have work too; run abso where to see who is where.`,
	};
}

/** A file an edit left holding collision markers (#11): again whenever the count changes. */
export function markedItem(draftId: string, file: string, blocks: number): NewsItem {
	return {
		key: `marked ${draftId} ${file} ${blocks}`,
		text: `${file} still has ${blocks === 1 ? "1 collision block" : `${blocks} collision blocks`} to settle: abso settle ${file} --yours|--theirs|--both`,
	};
}

const SETTLED_WHAT: Record<Kept, string> = {
	theirs: "it kept your lines",
	yours: "it kept its own lines, not yours",
	both: "it kept both its lines and yours",
	rewrote: "it kept part of each side or rewrote them",
};

/** The other author of a marked collision a publish settled (#11): what was kept, and any lines lost. */
export function settledItem(by: string, version: number, s: Settled): NewsItem {
	return {
		key: `settled ${by} ${version} ${s.file} ${s.theirs.version}`,
		text:
			`${by} settled its collision with your version ${s.theirs.version} in ${s.file}, pushing version ${version}: ${SETTLED_WHAT[s.kept]}.` +
			(s.lost
				? ` It also lost ${s.lost.length === 1 ? "a line" : `${s.lost.length} lines`} you both still had: ${s.lost.map((l) => `"${clip(l)}"`).join(", ")}.`
				: "") +
			` abso show ${version}:${s.file} shows the file.`,
	};
}

/** One line per other agent whose work or starting note meets files the draft just started changing (#37). */
export function overlapItems(draftId: string, overlaps: readonly Overlap[]): NewsItem[] {
	const byAgent = new Map<string, Overlap[]>();
	for (const o of overlaps) byAgent.set(o.agent, [...(byAgent.get(o.agent) ?? []), o]);
	const items: NewsItem[] = [];
	for (const [name, list] of byAgent) {
		const files = list.map((o) => o.file);
		const what = list.some((o) => o.changes) ? "has unpushed changes in" : "says it is starting on";
		const note = list.find((o) => o.starting)?.starting;
		items.push({
			key: `overlap ${draftId} ${name} ${files.join(" ")}`,
			text: `${name} ${what} ${files.join(", ")}${note ? ` ("${note}")` : ""}, which you just started changing. If it's the same work, talk to ${name} before going further; abso where shows the lines.`,
		});
	}
	return items;
}

/** A move that took lines the draft changes somewhere else (#28): the changes went with them. */
export function moveItem(atom: string, origin: Origin, from: string, to: string): NewsItem {
	const where = from === to ? `within ${to}` : `from ${from} to ${to}`;
	return {
		key: `move ${atom}`,
		text:
			`${origin.agent} pushed "${origin.message}" (${versionName(origin)}), which moved lines your draft changes ${where}; ` +
			`your changes moved with them. Run abso pull to see them there.`,
	};
}

/** A lines collision, as the agent whose draft it is reads it. */
export function linesText(c: Collision): string {
	const [a, b] = c.theirs.lines;
	const where = b >= a ? `lines ${a}-${b}` : `line ${a}`;
	return (
		`${c.theirs.agent} pushed "${c.theirs.message}" (${versionName(c.theirs)}), ` +
		`which changes ${c.file} ${where}, where your draft also changes lines; run abso pull to see both versions.`
	);
}

/** A changed or removed definition the draft uses (#11). */
export function definitionText(origin: Origin, change: string, name: string, file: string, line: number): string {
	return (
		`${origin.agent} pushed "${origin.message}" (${versionName(origin)}), which ${change}, ` +
		`and your draft uses ${name} in ${file} line ${line}; run abso pull to see the new definition.`
	);
}

/** What news assembly needs from a project. */
export interface NewsHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, AgentState>;
	draft(agent: AgentState): AtomId[];
	newerFor(agent: AgentState): ReadonlySet<AtomId>;
	spaceOf(agent: AgentState): Space;
	setOf(space: Space): ReadonlySet<AtomId>;
	viewAt(space: Space, version: number): View;
	origin(atom: AtomId, spaceName: string): Origin;
	collision(agent: AgentState, pair: Pair): Collision;
	definitionCollisions(agent: AgentState, newer: ReadonlySet<AtomId>): DefinitionCollision[];
	queueNews(agent: AgentState, items: readonly NewsItem[], entries: Entry[]): void;
}

function lineNews(host: NewsHost, agent: AgentState, pairs: readonly Pair[]): NewsItem[] {
	return pairs.map((p) => ({ key: pairKey(p), text: linesText(host.collision(agent, p)) }));
}

function definitionNews(defs: readonly DefinitionCollision[]): NewsItem[] {
	return defs.map((d) => ({ key: d.key, text: d.news }));
}

/**
 * One sentence per move in `just` that took lines the draft changes
 * (deletes, or writes right after) somewhere else (#28). The draft's
 * changes went with them, so this is news, not a collision.
 */
function moveNews(
	host: NewsHost,
	draft: readonly AtomId[],
	just: ReadonlySet<AtomId>,
	space: Space,
	version: number,
): NewsItem[] {
	const g = host.graph;
	const movers = [...just].filter((id) => g.atom(id).moves);
	if (movers.length === 0) return [];
	const claimed = new Set<string>();
	for (const id of draft) {
		for (const key of g.atom(id).writes) {
			const { kind, node } = parseKey(key);
			if ((kind === "line" || kind === "gap") && !isStartNode(node)) claimed.add(node);
		}
	}
	const was = host.viewAt(space, version - 1);
	const now = host.viewAt(space, last(space));
	const out: NewsItem[] = [];
	for (const id of movers) {
		const moved = g
			.atom(id)
			.writes.map((k) => parseKey(k))
			.filter((k) => k.kind === "pos" && claimed.has(k.node))
			.map((k) => k.node);
		if (moved.length === 0) continue;
		out.push(moveItem(id, host.origin(id, space.name), was.fileOf(moved[0]!), now.fileOf(moved[0]!)));
	}
	return out;
}

/** After the agent's own change: news when its draft now collides with work published after its base. */
export function newsAboutOwnDraft(host: NewsHost, agent: AgentState, entries: Entry[]): void {
	const draft = host.draft(agent);
	if (draft.length === 0) return;
	const newer = host.newerFor(agent);
	if (newer.size === 0) return;
	const lines = pairsIn(host.graph, draft, newer, unionOverlay(host.setOf(host.spaceOf(agent)), draft));
	host.queueNews(
		agent,
		[...lineNews(host, agent, lines), ...definitionNews(host.definitionCollisions(agent, newer))],
		entries,
	);
}

/** After a publish or a landing: news for every other agent in that space whose draft collides with what just arrived. */
export function newsForOthers(
	host: NewsHost,
	publisher: AgentState,
	space: Space,
	version: number,
	entries: Entry[],
): void {
	const just = new Set(space.versions[version]!.atoms);
	// Most publishes change no definition; then only the same-lines rule can bring news.
	const touched = touchedFiles(host.graph, just, [host.viewAt(space, version - 1), host.viewAt(space, last(space))]);
	const before = definitionsIn(host.viewAt(space, version - 1), touched);
	const after = definitionsIn(host.viewAt(space, last(space)), touched);
	const changedDefinitions = [...new Set([...before.keys(), ...after.keys()])].some(
		(name) => !before.has(name) || signature(before.get(name)!) !== signature(after.get(name) ?? []),
	);
	for (const agent of [...host.agents.values()].toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
		if (agent === publisher || agent.space !== space.name) continue;
		const draft = host.draft(agent);
		if (draft.length === 0) continue;
		const lines = pairsIn(host.graph, draft, just, unionOverlay(host.setOf(space), draft));
		const defs = changedDefinitions
			? host.definitionCollisions(agent, host.newerFor(agent)).filter((d) => just.has(d.by))
			: [];
		host.queueNews(
			agent,
			[...lineNews(host, agent, lines), ...definitionNews(defs), ...moveNews(host, draft, just, space, version)],
			entries,
		);
	}
}
