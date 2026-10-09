// What the project looks like now: status, the paths in a folder, and the labels. They read through
// SnapshotHost; today the host is the project in memory.

import type { AtomId, View } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import { countRefusals, type projectFileIn } from "./project-helpers.ts";
import type {
	AgentState,
	AgentStatus,
	EditsVia,
	Refusal,
	Starting,
	StatusAnswer,
	TellRecord,
	TellStatus,
} from "./project-types.ts";
import { last, SHARED, type Space, sharedBaseOf } from "./spaces.ts";

/** What the snapshot reads need from a project. */
export interface SnapshotHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly spaces: ReadonlyMap<string, Space>;
	queue(): readonly { readonly agent: string; readonly id: number }[];
	readonly refusals: readonly Refusal[];
	readonly labels: ReadonlyMap<string, readonly number[]>;
	readonly tells: ReadonlyMap<number, TellRecord>;
	needInit(): void;
	shared(): Space;
	draft(agent: AgentState): AtomId[];
	draftFiles(agent: AgentState): Set<string>;
	liveNote(agent: AgentState): Starting | undefined;
	openCollisions(agent: AgentState): { collisions?: AgentStatus["collisions"] };
	editsOf(agent: AgentState): {
		edits: EditsVia;
		modCurrent: boolean | null;
		lastEdit: number | null;
		joined: number | null;
	};
	setOf(space: Space): ReadonlySet<AtomId>;
	spaceNamed(name: string | null): Space;
	checkVersion(space: Space, version: number): void;
	viewAt(space: Space, version: number): View;
	agentView(agent: AgentState): View;
	version(): number;
	/** Shared's project file (224), or undefined before init or without one. */
	projectFile(): ReturnType<typeof projectFileIn>;
}

/**
 * The paths in an agent's view now (#37): what its folder should hold.
 * Reading it changes nothing. Binary files are included.
 */
export function agentPaths(
	host: SnapshotHost,
	agentName: string,
): { version: number; draft: string | null; files: string[] } {
	host.needInit();
	const agent = host.agents.get(agentName);
	if (!agent) throw new ProjectError("bad-request", `there is no agent ${JSON.stringify(agentName)}; join first`);
	return {
		version: agent.base,
		draft: agent.space === SHARED ? null : agent.space,
		files: host.agentView(agent).paths(),
	};
}

/** The paths in shared, or a named draft, at a version (the newest by default). */
export function pathsAt(
	host: SnapshotHost,
	version?: number,
	draft: string | null = null,
): { version: number; draft: string | null; files: string[] } {
	host.needInit();
	const space = host.spaceNamed(draft);
	const v = version ?? last(space);
	host.checkVersion(space, v);
	return { version: v, draft, files: host.viewAt(space, v).paths() };
}

/**
 * The paths in an agent's view now, for a reader (#41, F25): like
 * agentPaths, but an unknown agent is not found, and nothing is made.
 */
export function pathsOf(
	host: SnapshotHost,
	agentName: string,
): { agent: string; version: number; draft: string | null; files: string[] } {
	host.needInit();
	const agent = host.agents.get(agentName);
	if (!agent) throw new ProjectError("not-found", `there is no agent ${JSON.stringify(agentName)}`);
	return {
		agent: agent.name,
		version: agent.base,
		draft: agent.space === SHARED ? null : agent.space,
		files: host.agentView(agent).paths(),
	};
}

/** Every label, with the versions it marks, newest first. */
export function labels(host: SnapshotHost): { labels: Record<string, number[]> } {
	const out: Record<string, number[]> = {};
	for (const name of [...host.labels.keys()].toSorted()) out[name] = [...host.labels.get(name)!].toReversed();
	return { labels: out };
}

export function status(host: SnapshotHost): StatusAnswer {
	const agents = [...host.agents.values()]
		.toSorted((a, b) => (a.name < b.name ? -1 : 1))
		.map((agent) => {
			const draft = host.draft(agent);
			const files = host.draftFiles(agent);
			const queued = host.queue();
			const parked = [...agent.parked]
				.map(([space, p]) => {
					const set = host.setOf(host.spaces.get(space)!);
					return { draft: space === SHARED ? null : space, draftChanges: p.mine.filter((id) => !set.has(id)).length };
				})
				.filter((p) => p.draftChanges > 0)
				.toSorted((a, b) => ((a.draft ?? "") < (b.draft ?? "") ? -1 : 1));
			return {
				agent: agent.name,
				draft: agent.space === SHARED ? null : agent.space,
				base: agent.base,
				draftChanges: draft.length,
				files: [...files].toSorted(),
				parked,
				...(host.liveNote(agent)
					? { starting: { ...host.liveNote(agent)!, files: [...host.liveNote(agent)!.files] } }
					: {}),
				...host.openCollisions(agent),
				...(queued.some((q) => q.agent === agent.name)
					? { queued: queued.filter((q) => q.agent === agent.name).map((q) => q.id) }
					: {}),
				...host.editsOf(agent),
			};
		});
	const drafts = [...host.spaces.values()]
		.filter((s) => s.name !== SHARED)
		.toSorted((a, b) => (a.name < b.name ? -1 : 1))
		.map((s) => ({
			name: s.name,
			version: last(s),
			sharedBase: sharedBaseOf(s),
			changes: [...s.own].filter((id) => !host.shared().own.has(id)).length,
			agents: agents.filter((a) => a.draft === s.name).map((a) => a.agent),
		}));
	// Waiting announcements: the sentences still in agents' undelivered news.
	const waiting = new Map<string, string[]>();
	for (const agent of [...host.agents.values()].toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
		for (const text of agent.news) {
			if (!text.startsWith("Announcement from ")) continue;
			const list = waiting.get(text);
			if (list) list.push(agent.name);
			else waiting.set(text, [agent.name]);
		}
	}
	const announcements = [...waiting].map(([text, names]) => ({ text, waiting: names }));
	// Who has heard each of the newest tells, and when (277): the news and heard entries' times.
	const tells: TellStatus[] = [...host.tells.values()].toReversed().map((t) => ({
		id: t.id,
		text: t.text,
		at: t.at ?? null,
		to: [...t.heard]
			.toSorted(([a], [b]) => (a < b ? -1 : 1))
			.map(([agent, h]) => ({ agent, heard: h !== null, at: h?.at ?? null })),
	}));
	// Both project files in shared (224): say which one counts, never quietly.
	const file = host.projectFile();
	return {
		version: host.version(),
		agents,
		drafts,
		refusals: countRefusals(host.refusals),
		announcements,
		tells,
		...(file?.ignored ? { projectFile: { used: "abso.json" as const, ignored: file.ignored } } : {}),
	};
}
