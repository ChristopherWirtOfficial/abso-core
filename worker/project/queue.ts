// The merge queue: publishes to shared waiting for their batch's check.
// Writes go through QueueHost; today the host is Project.

import { type AtomId, buildAtom, type Graph, type ReadView } from "../../src/engine/index.ts";
import { unionOverlay } from "../../src/engine/state-source.ts";
import { autoSettledOf } from "./autosettle.ts";
import type { Pair } from "./collisions.ts";
import { definedTwice } from "./definitions.ts";
import { heldMessage, keptOf, lostLines } from "./markers.ts";
import { clip } from "./news.ts";
import { ProjectError } from "./project-error.ts";
import { projectFileIn } from "./project-helpers.ts";
import type {
	AgentState,
	Blobs,
	Collision,
	Entry,
	Modes,
	PublishAnswer,
	PullReason,
	QueuedPublish,
	Settled,
} from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";
import { treeHash } from "./tree.ts";
import { modesOf } from "./view-changes.ts";

/** What the merge queue needs from a project. */
export interface QueueHost {
	readonly graph: Graph;
	checkerReady(): boolean;
	sharedView(): ReadView;
	sharedOverlay?(atoms: readonly AtomId[]): ReadView;
	sharedAgentOverlay?(agent: AgentState, atoms: readonly AtomId[]): ReadView;
	queued(): readonly QueuedPublish[];
	queuedId(): number;
	checkingHas(id: number): boolean;
	replaceChecking(ids: Iterable<number>): void;
	uncheck(id: number): void;
	needInit(): void;
	shared(): Space;
	setOf(space: Space): ReadonlySet<AtomId>;
	view(set: ReadonlySet<AtomId>): ReadView;
	agentSet(agent: AgentState): Set<AtomId>;
	agentView(agent: AgentState): ReadView;
	pairs(draft: readonly AtomId[], against: ReadonlySet<AtomId>, settled: ReadonlySet<AtomId>): Pair[];
	describe(pair: Pair, yoursView: ReadView, theirsView: ReadView, spaceName: string): Collision;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
	refuse(
		agent: AgentState,
		space: Space,
		via: "publish" | "land",
		time: number,
		collisions: Collision[],
		entries: Entry[],
		message?: string,
	): { ok: false; collisions: Collision[] };
	currentChange(agent: AgentState, time: number): number | undefined;
	nextAt(): number;
	apply(entry: Entry): void;
	agentOf(name: string): AgentState;
	requireClosed(tie: { deps: readonly AtomId[] }, union: ReadonlySet<AtomId>): void;
	newsForOthers(publisher: AgentState, space: Space, version: number, entries: Entry[]): void;
	settledNews(agent: AgentState, version: number, settled: readonly Settled[], entries: Entry[]): void;
	addressedNews(agent: AgentState, version: number, entries: Entry[]): void;
	reviewNews(agent: AgentState, version: number, entries: Entry[]): void;
	queueNews(agent: AgentState, items: readonly { key: string; text: string }[], entries: Entry[]): void;
	flush(entries: Entry[]): void;
}

/** Whether shared's project file (abso.json, else avcs.json) turns the merge queue on (`"queue": true`). */
export function queueOn(host: QueueHost): boolean {
	if (!host.checkerReady()) return false;
	const file = projectFileIn(host.sharedView());
	if (!file) return false;
	try {
		return (JSON.parse(file.text) as { queue?: unknown }).queue === true;
	} catch {
		return false;
	}
}

/** With the queue on, nothing lands in shared unchecked; land and pluck don't go through the queue yet. */
export function notQueuedYet(host: QueueHost, what: string): void {
	if (queueOn(host))
		throw new ProjectError(
			"conflict",
			`${what} doesn't go through the merge queue yet; switch to shared, take the changes into your draft, and push`,
		);
}

/** Atoms of every queued publish, or only other agents' with `except`. */
export function queuedAtoms(host: QueueHost, except?: string): Set<AtomId> {
	return new Set(
		host
			.queued()
			.filter((q) => q.agent !== except)
			.flatMap((q) => q.changes),
	);
}

/**
 * Queue the agent's publish (#39). It is checked first against shared and
 * every publish queued ahead of it, as if those had landed: lines both
 * changed, and names defined twice, are refused now, so the queue only ever
 * holds publishes that merge cleanly with each other.
 */
export function enqueue(
	host: QueueHost,
	agent: AgentState,
	message: string,
	time: number,
	draft: readonly AtomId[],
	resolves: readonly AtomId[],
	entries: Entry[],
): PublishAnswer {
	const space = host.shared();
	const mineQueued = queuedAtoms(host);
	const changes = draft.filter((id) => !mineQueued.has(id));
	if (changes.length === 0) return { ok: true, version: last(space), changes: 0 };
	const ahead = queuedAtoms(host, agent.name);
	const now = host.setOf(space);
	if (ahead.size > 0) {
		const landed = unionOverlay(now, ahead);
		const theirsView = host.sharedOverlay ? host.sharedOverlay([...ahead]) : host.view(landed);
		const yoursView = host.sharedAgentOverlay
			? host.sharedAgentOverlay(agent, [...ahead])
			: host.view(unionOverlay(landed, host.agentSet(agent)));
		const queuedBy = (id: AtomId) => host.queued().find((q) => q.changes.includes(id));
		const collisions: Collision[] = host.pairs(changes, ahead, unionOverlay(landed, changes)).map((p) => {
			const c = host.describe(p, host.agentView(agent), theirsView, agent.space);
			const q = queuedBy(p.theirs);
			return q ? { ...c, theirs: { ...c.theirs, agent: q.agent, message: q.message, queued: q.id } } : c;
		});
		const mine = new Set(changes);
		for (const file of [...host.touchedFiles(changes, [yoursView])].sort()) {
			if (!yoursView.hasFile(file)) continue;
			for (const [name, defs] of definedTwice(yoursView, file)) {
				const yours = defs.find((d) => d.lines.some((l) => mine.has(host.graph.line(l)!.atom)));
				const theirs = defs.find((d) => d.lines.some((l) => ahead.has(host.graph.line(l)!.atom)));
				if (!yours || !theirs) continue;
				const q = queuedBy(host.graph.line(theirs.lines.find((l) => ahead.has(host.graph.line(l)!.atom))!)!.atom)!;
				collisions.push({
					kind: "duplicate",
					name,
					file,
					yours: { lines: [yours.start + 1, yours.end], text: `${yours.text}\n` },
					theirs: {
						lines: [theirs.start + 1, theirs.end],
						text: `${theirs.text}\n`,
						agent: q.agent,
						message: q.message,
						version: last(space),
						queued: q.id,
					},
				});
			}
		}
		if (collisions.length > 0) return host.refuse(agent, space, "publish", time, collisions, entries, message);
	}
	const view = host.agentView(agent);
	const auto = autoSettledOf(message);
	const settled: Settled[] = agent.marked
		.filter((r) => r.space === SHARED)
		.map((r) => {
			const lines = view.hasFile(r.file) ? view.lines(r.file).map((l) => l.text) : [];
			const lost = lostLines(lines, r);
			const held = heldMessage(agent, r.file);
			const by = auto.get(r.file);
			return {
				file: r.file,
				kept: keptOf(lines, r),
				theirs: { agent: r.agent, version: r.version },
				...(lost.length > 0 ? { lost } : {}),
				...(held ? { held } : {}),
				...(by ? { auto: by } : {}),
			};
		});
	const id = host.queuedId() + 1;
	const entry: Entry = {
		type: "queued",
		agent: agent.name,
		id,
		message,
		time,
		changes,
		resolves: [...resolves],
		...(settled.length > 0 ? { settled } : {}),
		change: host.currentChange(agent, time) ?? host.nextAt(),
	};
	entries.push(entry);
	host.apply(entry);
	const queued = host.queued();
	return {
		ok: true,
		queued: id,
		position: queued.length,
		ahead: queued.length - 1,
		changes: changes.length,
		...(settled.length > 0 ? { settled } : {}),
	};
}

/** The merge queue now (#39): waiting publishes in order, and which are in the batch being checked. */
export function queue(host: QueueHost): {
	items: { id: number; agent: string; message: string; time: number; changes: number; checking: boolean }[];
} {
	return {
		items: host.queued().map((q) => ({
			id: q.id,
			agent: q.agent,
			message: q.message,
			time: q.time,
			changes: q.changes.length,
			checking: host.checkingHas(q.id),
		})),
	};
}

/** Mark the first `n` queued publishes as the batch being checked (0 ends it). Not logged. */
export function queueChecking(host: QueueHost, n: number): number[] {
	const ids = host
		.queued()
		.slice(0, Math.max(0, n))
		.map((q) => q.id);
	host.replaceChecking(ids);
	return [...ids];
}

/** Shared with the first `n` queued publishes on top (#39): the files a batch's check runs on, and their tree hash. */
export function queueCandidate(
	host: QueueHost,
	n: number,
): {
	ids: number[];
	files: Record<string, string>;
	modes: Modes;
	blobs: Blobs;
	tree: string;
} {
	host.needInit();
	const items = host.queued().slice(0, Math.max(0, n));
	const changes = items.flatMap((q) => q.changes);
	const view =
		changes.length === 0
			? host.sharedView()
			: host.sharedOverlay
				? host.sharedOverlay(changes)
				: host.view(unionOverlay(host.setOf(host.shared()), changes));
	const files = view.files();
	const modes = modesOf(view);
	const blobs = view.blobs();
	return { ids: items.map((q) => q.id), files, modes, blobs, tree: treeHash({ files, modes, blobs }) };
}

/**
 * Land the first `n` queued publishes (#39), in order, each as its own
 * version, after their batch passed. Each tells others what arrived, its
 * author that it landed, and the authors of what it settled what it kept.
 */
export function queueLand(host: QueueHost, n: number, time: number): { versions: { id: number; version: number }[] } {
	const entries: Entry[] = [];
	const out: { id: number; version: number }[] = [];
	try {
		for (const q of host.queued().slice(0, Math.max(0, n))) {
			const agent = host.agentOf(q.agent);
			const space = host.shared();
			const union = unionOverlay(host.setOf(space), q.changes);
			const view = host.sharedOverlay ? host.sharedOverlay(q.changes) : host.view(union);
			const tie = buildAtom(view, {
				author: q.agent,
				message: q.message,
				time,
				needs: [...q.changes],
				resolves: q.resolves.filter((id) => union.has(id)),
			});
			host.requireClosed(tie, union);
			const version = last(space) + 1;
			const entry: Entry = {
				type: "publish",
				agent: q.agent,
				version,
				message: q.message,
				time,
				changes: q.changes,
				tie,
				// The agent may have edited since it queued, so its draft isn't reset as an immediate publish's is.
				rebase: false,
				...(q.settled ? { settled: q.settled } : {}),
				queued: q.id,
				change: q.change ?? host.nextAt(),
			};
			entries.push(entry);
			host.apply(entry);
			host.uncheck(q.id);
			host.newsForOthers(agent, space, version, entries);
			host.settledNews(agent, version, q.settled ?? [], entries);
			host.addressedNews(agent, version, entries);
			host.reviewNews(agent, version, entries);
			host.queueNews(
				agent,
				[{ key: `landed ${q.id}`, text: `Your queued push "${clip(q.message)}" landed as version ${version}.` }],
				entries,
			);
			out.push({ id: q.id, version });
		}
	} finally {
		host.flush(entries);
	}
	return { versions: out };
}

/**
 * Take a queued publish out (#39): its check failed, or its author withdrew
 * it. Its changes are simply still in its author's draft. Later queued
 * publishes that build on its changes come out with it.
 */
export function queuePull(
	host: QueueHost,
	id: number,
	reason: Exclude<PullReason, "depends">,
	time: number,
	output?: string,
): { pulled: number[] } {
	const entries: Entry[] = [];
	const pulled: number[] = [];
	try {
		const first = host.queued().find((q) => q.id === id);
		if (!first) throw new ProjectError("not-found", `nothing is queued with id ${id}`);
		const gone = new Set<AtomId>();
		for (const q of [...host.queued()]) {
			const builds = q.id !== id && q.changes.some((c) => host.graph.atom(c).deps.some((d) => gone.has(d)));
			if (q.id !== id && !builds) continue;
			const why: PullReason = q.id === id ? reason : "depends";
			const tail = output ? output.split("\n").slice(-20).join("\n").slice(-4000) : undefined;
			const entry: Entry = { type: "pulled", id: q.id, time, reason: why, ...(tail ? { output: tail } : {}) };
			entries.push(entry);
			host.apply(entry);
			for (const c of q.changes) gone.add(c);
			pulled.push(q.id);
			const said =
				why === "failed"
					? `the project's check failed on it on top of version ${last(host.shared())}${tail ? `:\n${tail}` : ""}`
					: why === "withdrawn"
						? "you withdrew it"
						: `it builds on queued push ${id}, which was turned back`;
			host.queueNews(
				host.agentOf(q.agent),
				[
					{
						key: `pulled ${q.id}`,
						text: `Your queued push "${clip(q.message)}" was turned back: ${said}. Its changes are still in your draft.`,
					},
				],
				entries,
			);
		}
	} finally {
		host.flush(entries);
	}
	return { pulled };
}

/** The agent withdraws its queued publishes (#39): refused while one is in the batch being checked. */
export function unqueue(host: QueueHost, agentName: string, time: number): { pulled: number[] } {
	const mine = host.queued().filter((q) => q.agent === agentName);
	if (mine.length === 0) throw new ProjectError("not-found", `${agentName} has nothing queued`);
	const busy = mine.find((q) => host.checkingHas(q.id));
	if (busy)
		throw new ProjectError(
			"conflict",
			`queued push ${busy.id} is being checked; it lands or is turned back in about a minute (abso drop takes it back after it lands)`,
		);
	const pulled: number[] = [];
	for (const q of mine)
		if (host.queued().some((x) => x.id === q.id)) pulled.push(...queuePull(host, q.id, "withdrawn", time).pulled);
	return { pulled };
}
