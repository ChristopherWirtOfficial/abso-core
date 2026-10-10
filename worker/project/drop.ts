// Drop published versions of shared (#10): a new shared version that leaves their changes out.
// Writes go through DropHost; today the host is Project.

import type { AtomId, Graph } from "../../src/engine/index.ts";
import type { NewsItem } from "./news.ts";
import { ProjectError } from "./project-error.ts";
import type { AgentState, DropAnswer, Entry } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What dropping versions needs from a project. */
export interface DropHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly spaces: ReadonlyMap<string, Space>;
	agent(name: string, entries: Entry[]): AgentState;
	shared(): Space;
	flush(entries: Entry[]): void;
	apply(entry: Entry): void;
	queueNews(agent: AgentState, items: NewsItem[], entries: Entry[]): void;
	addressedNews(agent: AgentState, version: number, entries: Entry[]): void;
}

/**
 * Drop published versions of shared (#10): a new shared version whose set
 * leaves out their changes. Later work that doesn't depend on them stays;
 * history keeps them. When later published work built on them, they are
 * refused with that work listed, unless `withDependents`, which drops it
 * too. Unpublished work that builds on them (an agent's draft, a named
 * draft not yet landed) always refuses it: drop never touches it.
 */
export function drop(
	host: DropHost,
	agentName: string,
	versions: readonly number[],
	message: string,
	time: number,
	options: { withDependents?: boolean } = {},
): DropAnswer {
	if (typeof message !== "string" || message.trim() === "")
		throw new ProjectError("bad-request", "drop needs a message saying why");
	if (!Array.isArray(versions) || versions.length === 0)
		throw new ProjectError("bad-request", "drop needs {versions: [number]}");
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const shared = host.shared();
	const g = host.graph;
	const targets = new Set<AtomId>();
	for (const v of versions) {
		if (!Number.isInteger(v) || v < 1 || v > last(shared))
			throw new ProjectError(
				"bad-request",
				`there is no version ${String(v)} of shared to drop (version 0 is the start)`,
			);
		const p = shared.versions[v]!;
		if (p.atoms.length === 0)
			throw new ProjectError("bad-request", `version ${v} added nothing (it is a drop), so there is nothing to drop`);
		const left = p.atoms.filter((id) => shared.own.has(id));
		if (left.length === 0)
			throw new ProjectError(
				"bad-request",
				`version ${v} was already dropped in version ${shared.droppedIn.get(p.atoms[0]!)}`,
			);
		for (const id of left) targets.add(id);
	}
	// Everything in shared that builds on them.
	const gone = new Set(targets);
	const stack = [...targets];
	while (stack.length > 0) {
		for (const d of g.dependentsOf(stack.pop()!)) {
			if (shared.own.has(d) && !gone.has(d)) {
				gone.add(d);
				stack.push(d);
			}
		}
	}
	const asked = new Set(versions);
	const dependents = [...new Set([...gone].map((id) => shared.publishedIn.get(id)!))]
		.filter((v) => !asked.has(v))
		.toSorted((a, b) => a - b);
	const describe = (v: number) => ({
		version: v,
		agent: shared.versions[v]!.agent,
		message: shared.versions[v]!.message,
	});
	if (dependents.length > 0 && options.withDependents !== true) {
		host.flush(entries);
		return { ok: false, dependents: dependents.map(describe), blocked: [] };
	}
	// Unpublished work that builds on them.
	const blocked: { agent?: string; draft?: string; files: string[] }[] = [];
	const buildsOn = (ids: Iterable<AtomId>): string[] => {
		const files = new Set<string>();
		for (const id of ids) {
			if (gone.has(id) || shared.own.has(id)) continue;
			if (g.atom(id).deps.some((d) => gone.has(d))) for (const f of g.filesOf(id)) files.add(f);
		}
		return [...files].toSorted();
	};
	for (const a of [...host.agents.values()].toSorted((x, y) => (x.name < y.name ? -1 : 1))) {
		const files = buildsOn([...a.mine, ...[...a.parked.values()].flatMap((p) => p.mine)]);
		if (files.length > 0) blocked.push({ agent: a.name, files });
	}
	for (const space of [...host.spaces.values()]
		.filter((s) => s.name !== SHARED)
		.toSorted((x, y) => (x.name < y.name ? -1 : 1))) {
		const files = buildsOn(space.own);
		if (files.length > 0) blocked.push({ draft: space.name, files });
	}
	if (blocked.length > 0) {
		host.flush(entries);
		return { ok: false, dependents: dependents.map(describe), blocked };
	}
	const version = last(shared) + 1;
	const all = [...versions, ...dependents].toSorted((a, b) => a - b);
	const entry: Entry = {
		type: "drop",
		agent: agent.name,
		version,
		message,
		time,
		versions: all,
		atoms: [...gone].toSorted((p, q) => g.atom(p).seq - g.atom(q).seq),
	};
	entries.push(entry);
	host.apply(entry);
	const names = all.map((v) => `version ${v}`).join(", ");
	for (const other of [...host.agents.values()].toSorted((x, y) => (x.name < y.name ? -1 : 1))) {
		if (other === agent || other.space !== SHARED) continue;
		host.queueNews(
			other,
			[
				{
					key: `drop ${version}`,
					text: `${agent.name} dropped ${names} from shared (version ${version}): "${message.trim()}". Run abso pull to take it out of your folder.`,
				},
			],
			entries,
		);
	}
	host.addressedNews(agent, version, entries);
	host.flush(entries);
	return { ok: true, version, dropped: all.map(describe) };
}
