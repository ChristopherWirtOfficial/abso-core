// Land a named draft in shared as one unit. Writes go through LandHost; today
// the host is Project. Ingest and pluck call landDraft, the inner step.

import { type AtomId, buildAtom, type Graph, type ReadView } from "../../src/engine/index.ts";
import { differenceSet, StableOverlaySet, unionOverlay } from "../../src/engine/state-source.ts";
import type { Pair } from "./collisions.ts";
import type { DefinitionRule } from "./definition-rule.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, Collision, Entry, LandAnswer } from "./project-types.ts";
import { SHARED, SharedAdditions, type Space, sharedBaseOf } from "./spaces.ts";

/** What landing a named draft needs from a project. */
export interface LandHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly graph: Graph;
	readonly spaces: ReadonlyMap<string, Space>;
	version(): number;
	nextAt(): number;
	notQueuedYet(what: string): void;
	checkClash(changes: readonly AtomId[]): void;
	agent(name: string, entries: Entry[]): AgentState;
	namedSpaceOf(agent: AgentState): Space;
	shared(): Space;
	setOf(space: Space): ReadonlySet<AtomId>;
	at(space: Space, version: number): ReadonlySet<AtomId>;
	view(set: ReadonlySet<AtomId>): ReadView;
	viewAt(space: Space, version: number, changes?: readonly AtomId[]): ReadView;
	sharedView(): ReadView;
	pairs(draft: readonly AtomId[], against: ReadonlySet<AtomId>, settled: ReadonlySet<AtomId>): Pair[];
	describe(pair: Pair, yoursView: ReadView, theirsView: ReadView, spaceName: string): Collision;
	definitionRule(): DefinitionRule;
	refuse(
		agent: AgentState,
		space: Space,
		via: "publish" | "land",
		time: number,
		collisions: Collision[],
		entries: Entry[],
	): { ok: false; collisions: Collision[] };
	requireClosed(tie: { deps: readonly AtomId[] }, union: ReadonlySet<AtomId>): void;
	apply(entry: Entry): void;
	newsForOthers(publisher: AgentState, space: Space, version: number, entries: Entry[]): void;
	addressedNews(agent: AgentState, version: number, entries: Entry[]): void;
	reviewNews(agent: AgentState, version: number, entries: Entry[]): void;
	flush(entries: Entry[]): void;
}

/**
 * Land the agent's named draft in shared as one unit: every change
 * published into it that shared doesn't have yet. Refused, like a publish,
 * when those changes collide with work that landed in shared after the
 * draft's base; sync the draft, settle, and land again.
 */
export function land(host: LandHost, agentName: string, message: string, time: number): LandAnswer {
	if (typeof message !== "string") throw new ProjectError("bad-request", "land needs a message");
	host.notQueuedYet("land");
	const known = host.agents.get(agentName);
	const landing = known && known.space !== SHARED ? host.spaces.get(known.space) : undefined;
	if (landing) host.checkClash([...landing.own].filter((id) => !host.shared().own.has(id)));
	const entries: Entry[] = [];
	const answer = landDraft(host, host.agent(agentName, entries), message, time, entries);
	host.flush(entries);
	return answer;
}

/**
 * What landing `changes` of a named draft would collide with in shared now (#41, the Drafts page reads it
 * too): the same pairs and definitions land refuses on.
 */
export function landCollisions(
	host: LandHost,
	space: Space,
	changes: AtomId[],
	pick: boolean,
): { collisions: Collision[]; newer: ReadonlySet<AtomId>; union: ReadonlySet<AtomId> } {
	const shared = host.shared();
	const base = host.at(shared, sharedBaseOf(space));
	const own = new StableOverlaySet(changes);
	const current = host.at(shared, host.version());
	const union = unionOverlay(current, changes);
	// The draft's own changes (some already plucked into shared) are never newer work to it.
	const newer = differenceSet(
		differenceSet(
			shared.membershipVersion
				? new SharedAdditions(shared, sharedBaseOf(space), base, current)
				: differenceSet(current, base),
			own,
		),
		space.own,
	);
	// A pluck is checked as the draft's base plus only the plucked changes.
	const draftView = pick
		? host.viewAt(shared, sharedBaseOf(space), changes)
		: host.viewAt(space, space.versions.length - 1);
	const describeLand = (p: Pair): Collision => host.describe(p, draftView, host.sharedView(), SHARED);
	const collisions = [
		...host.pairs(changes, newer, union).map(describeLand),
		...host
			.definitionRule()
			.collisions(own, draftView, host.viewAt(shared, sharedBaseOf(space)), host.sharedView(), newer, SHARED)
			.map((d) => d.collision),
	];
	return { collisions, newer, union };
}

/** The inner land, also used when ingesting a git push and when plucking. */
export function landDraft(
	host: LandHost,
	agent: AgentState,
	message: string,
	time: number,
	entries: Entry[],
	pick?: { space: Space; changes: AtomId[] },
): LandAnswer {
	const space = pick?.space ?? host.namedSpaceOf(agent);
	const shared = host.shared();
	const changes = (pick?.changes ?? [...space.own])
		.filter((id) => !shared.own.has(id) && !shared.droppedIn.has(id))
		.sort((p, q) => host.graph.atom(p).seq - host.graph.atom(q).seq);
	if (changes.length === 0) return { ok: true, version: host.version(), changes: 0 };
	const { collisions, newer, union } = landCollisions(host, space, changes, !!pick);
	if (collisions.length > 0) return host.refuse(agent, space, "land", time, collisions, entries);
	const seen = host.pairs(changes, differenceSet(host.at(shared, host.version()), newer), union);
	const resolves = [...new Set(seen.flatMap((p) => [p.yours, p.theirs]))];
	const tie = buildAtom(host.viewAt(shared, host.version(), changes), {
		author: agent.name,
		message,
		time,
		needs: changes,
		resolves,
	});
	host.requireClosed(tie, union);
	const version = host.version() + 1;
	// A pluck leaves the draft where it is: the rest of it lands later.
	const rebase = !pick && shared.versions.length - 1 === sharedBaseOf(space);
	entries.push({
		type: "land",
		space: space.name,
		agent: agent.name,
		version,
		message,
		time,
		changes,
		tie,
		rebase,
		change: space.startedAt ?? host.nextAt(),
	});
	host.apply(entries[entries.length - 1]!);
	host.newsForOthers(agent, shared, version, entries);
	host.addressedNews(agent, version, entries);
	host.reviewNews(agent, version, entries);
	return { ok: true, version, changes: changes.length };
}
