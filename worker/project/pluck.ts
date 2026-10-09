// Take part of a named draft into shared (#27): some of its versions as one new version of shared.
// Writes go through PluckHost; today the host is Project.

import type { AtomId, Graph } from "../../src/engine/index.ts";
import { ProjectError } from "./project-error.ts";
import { checkDraftName } from "./project-helpers.ts";
import type { AgentState, Entry, LandAnswer, PluckAnswer } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

/** What plucking versions of a named draft needs from a project. */
export interface PluckHost {
	readonly graph: Graph;
	readonly spaces: ReadonlyMap<string, Space>;
	agent(name: string, entries: Entry[]): AgentState;
	shared(): Space;
	notQueuedYet(what: string): void;
	strandedFiles(draft: readonly AtomId[], set: ReadonlySet<AtomId>): string[];
	checkClash(changes: readonly AtomId[]): void;
	land(
		agent: AgentState,
		message: string,
		time: number,
		entries: Entry[],
		pick?: { space: Space; changes: AtomId[] },
	): LandAnswer;
	flush(entries: Entry[]): void;
}

/**
 * Take part of a named draft into shared (#27): the changes of some of its
 * versions, as one new version of shared, checked for collisions like a
 * land. When they build on other versions of the draft, those are listed
 * and it is refused, unless `withDependencies` takes them too. The draft
 * stays as it is; landing it later brings in only what's left.
 */
export function pluck(
	host: PluckHost,
	agentName: string,
	draftName: string,
	versions: readonly number[],
	message: string,
	time: number,
	options: { withDependencies?: boolean } = {},
): PluckAnswer {
	if (typeof message !== "string" || message.trim() === "")
		throw new ProjectError("bad-request", "pluck needs a message saying why");
	if (!Array.isArray(versions) || versions.length === 0)
		throw new ProjectError("bad-request", "pluck needs {versions: [number]}");
	host.notQueuedYet("pluck");
	const space = host.spaces.get(checkDraftName(draftName));
	if (!space || space.name === SHARED)
		throw new ProjectError("bad-request", `there is no named draft ${JSON.stringify(draftName)}`);
	const entries: Entry[] = [];
	const agent = host.agent(agentName, entries);
	const shared = host.shared();
	const g = host.graph;
	const pending = (id: AtomId): boolean => !shared.own.has(id) && !shared.droppedIn.has(id);
	const chosen = new Set<AtomId>();
	for (const v of versions) {
		if (!Number.isInteger(v) || v < 1 || v > last(space))
			throw new ProjectError("bad-request", `draft ${space.name} has no version ${String(v)} to pluck`);
		const atoms = space.versions[v]!.atoms.filter(pending);
		if (atoms.length === 0)
			throw new ProjectError("bad-request", `draft ${space.name} version ${v} has nothing that shared doesn't have`);
		for (const id of atoms) chosen.add(id);
	}
	// What they build on in the draft that shared doesn't have yet.
	const stack = [...chosen];
	const needed = new Set<AtomId>();
	while (stack.length > 0) {
		for (const d of g.atom(stack.pop()!).deps) {
			if (chosen.has(d) || needed.has(d) || !space.own.has(d) || !pending(d)) continue;
			needed.add(d);
			stack.push(d);
		}
	}
	const asked = new Set(versions);
	const neededVersions = [...new Set([...needed].map((id) => space.publishedIn.get(id)!))]
		.filter((v) => !asked.has(v))
		.toSorted((a, b) => a - b);
	const describe = (v: number) => ({
		version: v,
		agent: space.versions[v]!.agent,
		message: space.versions[v]!.message,
	});
	if (neededVersions.length > 0 && options.withDependencies !== true) {
		host.flush(entries);
		return { ok: false, needs: neededVersions.map(describe), collisions: [] };
	}
	const stranded = host.strandedFiles([...chosen, ...needed], shared.own);
	if (stranded.length > 0) {
		host.flush(entries);
		throw new ProjectError(
			"conflict",
			`those changes to ${stranded.join(", ")} build on lines a drop took out of shared`,
		);
	}
	const all = [...versions, ...neededVersions].toSorted((a, b) => a - b);
	try {
		host.checkClash([...chosen, ...needed]);
	} catch (e) {
		host.flush(entries);
		throw e;
	}
	const answer = host.land(agent, message, time, entries, { space, changes: [...chosen, ...needed] });
	host.flush(entries);
	if (!answer.ok) return { ok: false, needs: [], collisions: answer.collisions };
	return { ok: true, version: answer.version, changes: answer.changes ?? 0, plucked: all.map(describe) };
}
