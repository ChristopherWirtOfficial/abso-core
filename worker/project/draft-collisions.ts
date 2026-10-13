// Whether agents' unpublished changes would collide (#41, F22), read through DraftCollisionHost; today the host
// is the project in memory.

import { type AtomId, type Graph, parseKey, type ReadView } from "../../src/engine/index.ts";
import { describeSide, fileOfKey, type Pair } from "./collisions.ts";
import type { DefinitionRule } from "./definition-rule.ts";
import { type Definition, definedTwice } from "./definitions.ts";
import { pathKey } from "./pathkey.ts";
import type { CollisionSide, DraftCollision } from "./project-types.ts";
import { last, SHARED, type Space } from "./spaces.ts";

interface Agent {
	readonly name: string;
	readonly space: string;
}

/** What the draft collision read needs from a project. */
export interface DraftCollisionHost {
	readonly graph: Graph;
	readonly agents: ReadonlyMap<string, Agent>;
	needInit(): void;
	shared(): Space;
	sharedView(): ReadView;
	definitionRule(): DefinitionRule;
	draft(agent: Agent): AtomId[];
	agentView(agent: Agent): ReadView;
	view(set: ReadonlySet<AtomId>): ReadView;
	pairs(draft: readonly AtomId[], against: ReadonlySet<AtomId>, settled: ReadonlySet<AtomId>): Pair[];
	touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string>;
}

/**
 * Whether agents' unpublished changes would collide (#41, F22), by the
 * publish rule: for each pair of agents working in shared, one agent's
 * changes as if published on shared now, then the other's checked against
 * them, both ways round. Same lines, a definition one changes that the
 * other's new lines use, the same attribute, and a name both define at the
 * top of a file (refused once the second syncs onto the first's work). Exact for shared at `version`; as shared moves on, so can
 * the answer, as a real publish's would. `file` or `folder` narrows it.
 */
export function draftCollisions(
	host: DraftCollisionHost,
	options: { file?: string; folder?: string } = {},
): {
	version: number;
	agents: string[];
	collisions: DraftCollision[];
} {
	host.needInit();
	const working = [...host.agents.values()]
		.filter((a) => a.space === SHARED && host.draft(a).length > 0)
		.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const shared = host.shared().own;
	const sharedView = host.sharedView();
	const out: DraftCollision[] = [];
	const side = (agent: string, file: string, s: CollisionSide) => ({ agent, file, lines: s.lines, text: s.text });
	for (let i = 0; i < working.length; i++) {
		for (let j = 0; j < working.length; j++) {
			if (i === j) continue;
			const a = working[i]!;
			const b = working[j]!;
			const draftA = host.draft(a);
			const draftB = host.draft(b);
			const newer = new Set(draftA);
			const union = new Set([...shared, ...draftA, ...draftB]);
			const viewA = host.agentView(a);
			const viewB = host.agentView(b);
			if (i < j) {
				// Lines and attributes: the same either way round, so once per pair.
				const paired = new Set<string>();
				for (const pair of host.pairs(draftB, newer, union)) {
					paired.add(`${pair.theirs} ${pair.yours}`);
					const file = fileOfKey(pair.keys[0]!.key, viewB);
					const fileKeys = pair.keys.filter((k) => fileOfKey(k.key, viewB) === file).map((k) => k.key);
					const attrs = fileKeys.map((k) => parseKey(k)).filter((k) => k.kind === "attr");
					const fileA = viewA.hasFile(file) ? file : fileOfKey(pair.keys[0]!.key, viewA);
					if (attrs.length === fileKeys.length) {
						const name = attrs[0]!.attr!;
						const valueOf = (atom: AtomId) =>
							(host.graph.atom(atom).attrs ?? []).find((x) => x.file === file && x.name === name)?.value ?? "";
						out.push({
							kind: "attribute",
							name,
							file,
							first: { agent: a.name, file, lines: [1, 0], text: valueOf(pair.theirs) },
							second: { agent: b.name, file, lines: [1, 0], text: valueOf(pair.yours) },
						});
					} else {
						out.push({
							kind: "lines",
							file,
							first: side(a.name, fileA, describeSide(viewA, pair.theirs, fileA, fileKeys)),
							second: side(b.name, file, describeSide(viewB, pair.yours, file, fileKeys)),
						});
					}
				}
				// A name both define at the top level of one file: what the second meets once it syncs onto the
				// first's work, as the publish rule checks it then. Not when the two definitions are one lines collision.
				const both = host.view(union);
				const mineA = new Set(draftA);
				const mineB = new Set(draftB);
				const filesA = host.touchedFiles(draftA, [viewA]);
				for (const file of [...host.touchedFiles(draftB, [viewB])].filter((f) => filesA.has(f)).toSorted()) {
					if (!both.hasFile(file)) continue;
					for (const [name, defs] of definedTwice(both, file)) {
						const by = (mine: Set<AtomId>) => defs.find((d) => d.lines.some((l) => mine.has(host.graph.line(l)!.atom)));
						const dA = by(mineA);
						const dB = by(mineB);
						if (!dA || !dB || dA === dB) continue;
						const atomsOf = (d: Definition, mine: Set<AtomId>) =>
							d.lines.map((l) => host.graph.line(l)!.atom).filter((x) => mine.has(x));
						if (atomsOf(dA, mineA).some((x) => atomsOf(dB, mineB).some((y) => paired.has(`${x} ${y}`)))) continue;
						out.push({
							kind: "duplicate",
							name,
							file,
							first: { agent: a.name, file, lines: [dA.start + 1, dA.end], text: `${dA.text}\n` },
							second: { agent: b.name, file, lines: [dB.start + 1, dB.end], text: `${dB.text}\n` },
						});
					}
				}
			}
			// Definitions: b's new lines use a name whose definition a's changes change.
			const nowView = host.view(new Set([...shared, ...draftA]));
			for (const d of host.definitionRule().collisions(new Set(draftB), viewB, sharedView, nowView, newer, SHARED)) {
				const c = d.collision;
				out.push({
					kind: "definition",
					name: c.name!,
					file: c.file,
					first: { agent: a.name, file: c.theirs.file ?? c.file, lines: c.theirs.lines, text: c.theirs.text },
					second: side(b.name, c.file, c.yours),
				});
			}
		}
	}
	const fileKey = options.file !== undefined ? pathKey(options.file) : undefined;
	const folderParts =
		options.folder !== undefined ? options.folder.split("/").filter((s) => s !== "" && s !== ".") : undefined;
	const under = (path: string): boolean => {
		if (fileKey !== undefined && pathKey(path) !== fileKey) return false;
		if (folderParts !== undefined && folderParts.length > 0) {
			const parts = path.split("/");
			if (
				parts.length <= folderParts.length ||
				pathKey(parts.slice(0, folderParts.length).join("/")) !== pathKey(folderParts.join("/"))
			)
				return false;
		}
		return true;
	};
	const narrowed =
		fileKey === undefined && folderParts === undefined
			? out
			: out.filter((c) => under(c.first.file) || under(c.second.file));
	return { version: last(host.shared()), agents: working.map((a) => a.name), collisions: narrowed };
}
