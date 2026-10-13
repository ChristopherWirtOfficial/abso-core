// Refuse work whose paths would clash in shared. Reads go through
// CheckClashHost; today the host is Project.

import type { AtomId, ReadView } from "../../src/engine/index.ts";
import { unionOverlay } from "../../src/engine/state-source.ts";
import { ProjectError } from "./project-error.ts";
import { configProblem, PROJECT_FILES } from "./project-helpers.ts";
import type { Space } from "./spaces.ts";
import { clashIn } from "./spelling.ts";

/** What the spelling clash check needs from a project. */
export interface CheckClashHost {
	shared(): Space;
	setOf(space: Space): ReadonlySet<AtomId>;
	view(set: ReadonlySet<AtomId>): ReadView;
	sharedView(): ReadView;
	sharedOverlay?(atoms: readonly AtomId[]): ReadView;
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
}

/**
 * Refuse work whose paths would clash in shared (#49), before anything of it
 * is written.
 */
export function checkClash(
	host: CheckClashHost,
	changes: readonly AtomId[],
	ahead: ReadonlySet<AtomId> = new Set(),
): void {
	if (changes.length === 0) return;
	let view: ReadView;
	let now: ReadView;
	try {
		// Publishes queued ahead (#39) land first, so they count as shared.
		const base = host.setOf(host.shared());
		const queued = unionOverlay(base, ahead);
		view = host.sharedOverlay ? host.sharedOverlay([...ahead, ...changes]) : host.view(unionOverlay(queued, changes));
		now =
			ahead.size === 0 ? host.sharedView() : host.sharedOverlay ? host.sharedOverlay([...ahead]) : host.view(queued);
	} catch (e) {
		if ((e as { code?: string }).code === "not-closed") return; // stranded by a drop: the publish says so itself
		throw e;
	}
	const touched = host.touchedFiles(changes, [view]);
	const why = clashIn(view, touched, now);
	if (why) throw new ProjectError("conflict", why);
	// A broken project file would quietly switch off files kept whole, the queue and reviewers.
	for (const name of PROJECT_FILES) {
		if (!touched.has(name) || !view.hasFile(name)) continue;
		const bad = configProblem(view.text(name));
		if (bad)
			throw new ProjectError("conflict", `${name} ${bad}. Shared keeps the one it has; fix yours and push again.`);
	}
}
