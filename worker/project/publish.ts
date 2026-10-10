// Add the agent's draft to its space. Writes go through PublishHost; today
// the host is Project. Ingest calls publishDraft, the inner step.

import { type AtomId, buildAtom, type Hunk, joinLines, type View } from "../../src/engine/index.ts";
import type { Pair } from "./collisions.ts";
import type { DefinitionCollision } from "./definition-rule.ts";
import { keptOf, lostLines, settleLines } from "./markers.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Collision, Entry, Meta, Mode, PublishAnswer, Settled } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What publishing needs from a project. */
export interface PublishHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	nextAt(): number;
	checkClash(changes: readonly AtomId[], ahead?: ReadonlySet<AtomId>): void;
	queueOn(): boolean;
	queuedAtoms(except?: string): Set<AtomId>;
	agent(name: string, entries: Entry[]): AgentState;
	draft(agent: AgentState): AtomId[];
	spaceOf(agent: AgentState): Space;
	strandedFiles(draft: readonly AtomId[], set: ReadonlySet<AtomId>): string[];
	setOf(space: Space): ReadonlySet<AtomId>;
	markedFiles(agent: AgentState): string[];
	agentView(agent: AgentState): View;
	recordFile(
		agent: AgentState,
		view: View,
		path: string,
		text: string | null | undefined,
		time: number,
		meta: Meta,
		entries: Entry[],
		mode?: Mode,
		blob?: string,
		hunks?: readonly Hunk[],
	): boolean;
	expressMoves(agent: AgentState, time: number, entries: Entry[]): void;
	pairs(draft: readonly AtomId[], against: ReadonlySet<AtomId>, settled: ReadonlySet<AtomId>): Pair[];
	collision(agent: AgentState, pair: Pair): Collision;
	definitionCollisions(agent: AgentState, newer: ReadonlySet<AtomId>): DefinitionCollision[];
	duplicates(agent: AgentState): Collision[];
	refuse(
		agent: AgentState,
		space: Space,
		via: "publish" | "land",
		time: number,
		collisions: Collision[],
		entries: Entry[],
	): { ok: false; collisions: Collision[] };
	markerCollisions(agent: AgentState): Collision[];
	enqueue(
		agent: AgentState,
		message: string,
		time: number,
		draft: readonly AtomId[],
		resolves: readonly AtomId[],
		entries: Entry[],
	): PublishAnswer;
	view(set: ReadonlySet<AtomId>): View;
	requireClosed(tie: { deps: readonly AtomId[] }, union: ReadonlySet<AtomId>): void;
	newerFor(agent: AgentState): Set<AtomId>;
	currentChange(agent: AgentState, time: number): number | undefined;
	apply(entry: Entry): void;
	newsForOthers(publisher: AgentState, space: Space, version: number, entries: Entry[]): void;
	settledNews(agent: AgentState, version: number, settled: readonly Settled[], entries: Entry[]): void;
	addressedNews(agent: AgentState, version: number, entries: Entry[]): void;
	reviewNews(agent: AgentState, version: number, entries: Entry[]): void;
	flush(entries: Entry[]): void;
}

/**
 * Add the agent's draft to its space (shared, or its named draft). Refused
 * only when a draft change collides with work published to that space
 * after the agent's base.
 */
export function publish(
	host: PublishHost,
	agentName: string,
	message: string,
	time: number,
	options: { asIs?: boolean } = {},
): PublishAnswer {
	if (typeof message !== "string") throw new ProjectError("bad-request", "push needs a message");
	const known = host.agents.get(agentName);
	if (known && known.space === SHARED)
		host.checkClash(host.draft(known), host.queueOn() ? host.queuedAtoms(known.name) : undefined);
	const entries: Entry[] = [];
	const answer = publishDraft(host, host.agent(agentName, entries), message, time, entries, options.asIs === true);
	host.flush(entries);
	return answer;
}

/** The inner publish, also used when ingesting a git push. */
export function publishDraft(
	host: PublishHost,
	agent: AgentState,
	message: string,
	time: number,
	entries: Entry[],
	asIs = false,
	direct = false,
): PublishAnswer {
	const space = host.spaceOf(agent);
	const stranded = host.strandedFiles(host.draft(agent), host.setOf(space));
	if (stranded.length > 0) {
		throw new ProjectError(
			"conflict",
			`your unpushed changes to ${stranded.join(", ")} build on lines a drop took out of shared; ` +
				`restore those files (abso restore ${stranded.join(" ")}), pull, and make the change again`,
		);
	}
	// asIs (#11): every block of markers keeps both sides, and the publish says which files it settled that way.
	if (asIs) {
		for (const file of host.markedFiles(agent)) {
			const view = host.agentView(agent);
			if (!view.hasFile(file)) continue;
			const s = settleLines(
				view.lines(file).map((l) => l.text),
				"both",
			);
			if (s.blocks > 0) host.recordFile(agent, view, file, joinLines(s.lines), time, {}, entries);
		}
	}
	host.expressMoves(agent, time, entries);
	const draft = host.draft(agent);
	if (draft.length === 0) return { ok: true, version: last(space), changes: 0 };
	const now = host.setOf(space);
	const union = new Set([...now, ...draft]);
	const newer = host.newerFor(agent);
	const collisions = [
		...host.pairs(draft, newer, union).map((p) => host.collision(agent, p)),
		...host.definitionCollisions(agent, newer).map((d) => d.collision),
		...host.duplicates(agent),
	];
	if (collisions.length > 0) return host.refuse(agent, space, "publish", time, collisions, entries);
	// Settled means the markers are gone (#11): refused while the draft adds any.
	const marked = host.markerCollisions(agent);
	if (marked.length > 0) return host.refuse(agent, space, "publish", time, marked, entries);
	// What the agent has seen collide (it synced past both sides) and not
	// settled by an edit. Lines both sides changed, still untouched since the
	// sync, are both in the file, and publishing that doubles them in shared
	// (#37: twenty goals twice, shared red for three versions). So
	// that is refused unless the agent says to publish as it is (asIs); then,
	// like any other seen collision, publishing settles it.
	const seen = host.pairs(draft, new Set([...now].filter((id) => !newer.has(id))), union);
	if (!asIs) {
		const untouched = seen
			.map((p) => host.collision(agent, p))
			.filter((c) => c.kind === "lines")
			.map((c) => ({ ...c, untouched: true as const }));
		if (untouched.length > 0) return host.refuse(agent, space, "publish", time, untouched, entries);
	}
	const resolves = [...new Set(seen.flatMap((p) => [p.yours, p.theirs]))];
	if (space.name === SHARED && !direct && host.queueOn())
		return host.enqueue(agent, message, time, draft, resolves, entries);
	const tie = buildAtom(host.view(union), { author: agent.name, message, time, needs: draft, resolves });
	host.requireClosed(tie, union);
	const version = last(space) + 1;
	const othersPublished = space.versions.slice(agent.base + 1).some((p) => p.agent !== agent.name);
	// What this publish went on top of that the agent's folder doesn't have yet (#37).
	const mergedWith = space.versions
		.slice(agent.base + 1)
		.filter((p) => p.agent !== agent.name && (p.atoms.length > 0 || p.dropped !== undefined))
		.map((p) => ({ version: p.version, agent: p.agent, message: p.message }));
	// What each marked collision kept, judged from the file as published (#11).
	const view = host.agentView(agent);
	const settled: Settled[] = agent.marked
		.filter((r) => r.space === space.name)
		.map((r) => {
			const lines = view.hasFile(r.file) ? view.lines(r.file).map((l) => l.text) : [];
			const lost = lostLines(lines, r);
			return {
				file: r.file,
				kept: keptOf(lines, r),
				theirs: { agent: r.agent, version: r.version },
				...(lost.length > 0 ? { lost } : {}),
			};
		});
	entries.push({
		type: "publish",
		agent: agent.name,
		...(space.name !== SHARED ? { space: space.name } : {}),
		version,
		message,
		time,
		changes: draft,
		tie,
		rebase: !othersPublished,
		...(settled.length > 0 ? { settled } : {}),
		change: host.currentChange(agent, time) ?? host.nextAt(),
	});
	host.apply(entries[entries.length - 1]!);
	host.newsForOthers(agent, space, version, entries);
	host.settledNews(agent, version, settled, entries);
	if (space.name === SHARED) {
		host.addressedNews(agent, version, entries);
		host.reviewNews(agent, version, entries);
	}
	return {
		ok: true,
		version,
		changes: draft.length,
		...(mergedWith.length > 0 ? { mergedWith } : {}),
		...(settled.length > 0 ? { settled } : {}),
	};
}
