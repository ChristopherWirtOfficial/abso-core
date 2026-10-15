// Blame and why for shared, read from the engine's graph (slice 2 of #18).
// A line's id names the atom that inserted it, so blame is a lookup per line:
// that change's author and message, and the publish that brought it into
// shared, with its message. Why adds the change's reasons, what it settled,
// and the reasons other changes give that point at it, and the line's
// earlier changes (trail.ts).
import { type Atom, type AtomId, type LineId, type ReadView, seqOf, View } from "../../src/engine/index.ts";
import { isClosedSet, markClosed, StableSet } from "../../src/engine/state-source.ts";
import { blocksIn, isMarkerLine } from "./markers.ts";
import { pathKey } from "./pathkey.ts";
import type { Project } from "./project.ts";
import { projectFileIn } from "./project-helpers.ts";
import { type TrailStep, trail } from "./trail.ts";

export interface BlameLine {
	n: number;
	text: string;
	atom: AtomId;
	author: string;
	/** The shared version that brought it in; null while it's only in a draft. */
	version: number | null;
	/** Not published anywhere yet: the agent's own unpublished change. */
	unpublished?: true;
}

interface Publish {
	/** null for shared, else the named draft it was published into. */
	draft: string | null;
	version: number;
	agent: string;
	message: string;
	time: number;
}

/** Whose view: shared (the default, at `version`), a named draft (at `version`), or an agent's view now. */
export interface BlameWhere {
	version?: number;
	draft?: string;
	agent?: string;
}

function publishOf(project: Project, atom: AtomId): Publish | null {
	return project.publishOf(atom) ?? null;
}

const badRequest = (message: string) => Object.assign(new Error(message), { code: "bad-request" });

function viewOf(project: Project, where: BlameWhere) {
	let view;
	let name: string;
	if (where.agent !== undefined) {
		if (where.version !== undefined || where.draft !== undefined)
			throw badRequest("an agent's view is its current one: give agent alone");
		const draft = project.draftOf(where.agent);
		if (!draft) throw badRequest(`there is no agent ${JSON.stringify(where.agent)}`);
		view = draft.view;
		name = `${where.agent}'s view`;
	} else if (where.draft !== undefined) {
		const version = where.version ?? project.lastVersion(where.draft);
		view = project.viewAt(version, { draft: where.draft });
		name = `draft ${where.draft} at version ${version}`;
	} else {
		view = where.version === undefined ? project.sharedView() : project.viewAt(where.version);
		name = where.version === undefined ? "shared" : `shared at version ${where.version}`;
	}
	return { view, name };
}

/** A file's lines, by any spelling (#41, F7), and the stored spelling. */
function lines(project: Project, asked: string, where: BlameWhere) {
	const { view, name } = viewOf(project, where);
	const file = project.spellingIn(view, asked);
	if (!view.hasFile(file)) throw badRequest(`${asked} isn't in ${name}`);
	return { file, all: view.lines(file), view };
}

/**
 * Every line of a file (or lines from..to), with who wrote it and the
 * publishes behind them: in shared, a named draft, or an agent's view with
 * its unpublished changes.
 */
export function blame(
	project: Project,
	asked: string,
	from?: number,
	to?: number,
	version?: number,
	where: Omit<BlameWhere, "version"> = {},
) {
	const { file, all } = lines(project, asked, { version, ...where });
	const first = Math.max(1, from ?? 1);
	const last = Math.min(all.length, to ?? all.length);
	const graph = project.graph;
	const rows: BlameLine[] = all.slice(first - 1, last).map((l, i) => ({
		n: first + i,
		text: l.text,
		atom: l.atom,
		author: graph.atom(l.atom).author,
		version: project.versionOf(l.atom) ?? null,
		...(project.publishOf(l.atom) === undefined ? { unpublished: true as const } : {}),
	}));
	const atoms = [...new Set(rows.map((r) => r.atom))]
		.sort((a, b) => graph.atom(a).seq - graph.atom(b).seq)
		.map((id) => {
			const a = graph.atom(id);
			return { atom: id, author: a.author, message: a.message, time: a.time, publish: publishOf(project, id) };
		});
	return {
		file,
		version: where.agent !== undefined ? null : (version ?? project.lastVersion(where.draft ?? null)),
		...(where.draft !== undefined ? { draft: where.draft } : {}),
		...(where.agent !== undefined ? { agent: where.agent } : {}),
		total: all.length,
		from: first,
		to: last,
		lines: rows,
		atoms,
	};
}

/**
 * The settle a line was kept through, when its own change settled nothing:
 * an edit that took out the markers of a block the line sat in (as yours or
 * theirs), as abso settle --yours, --theirs or --both makes. The earliest,
 * if several did.
 */
function keptThrough(project: Project, view: ReadView, file: string, line: LineId, author: Atom): Atom | undefined {
	const graph = project.graph;
	const set = view.set;
	// Only atoms that write or take out the file's lines can take out its markers (abso Capacity): every atom in the
	// history was read on a stored graph.
	for (const id of graph.eachAtomIn(file)) {
		if (seqOf(id) <= author.seq) continue;
		const s = graph.atom(id);
		if (s.resolves.length === 0 || !set.has(s.id)) continue;
		const marks = s.deletes.filter((id) => {
			const info = graph.line(id);
			return info !== undefined && info.file === file && isMarkerLine(info.text);
		});
		if (marks.length === 0) continue;
		// The file just before the settle, markers and all: of a closed set, its atoms before the settle, which a
		// stored set answers one by one; otherwise listed.
		const before = new View(
			graph,
			isClosedSet(set)
				? markClosed(new BeforeSet(set, s.seq))
				: graph
						.atoms()
						.slice(0, s.seq)
						.filter((a) => set.has(a.id))
						.map((a) => a.id),
		);
		if (!before.hasFile(file)) continue;
		const lines = before.lines(file);
		const at = lines.findIndex((l) => l.id === line);
		if (at < 0) continue;
		const block = blocksIn(lines.map((l) => l.text)).find((b) => at > b.start && at < b.end);
		if (block && marks.includes(lines[block.start]!.id)) return s;
	}
	return undefined;
}

/** A set's atoms numbered below a limit. Atoms depend only on earlier ones, so a closed set's prefix is closed. */
class BeforeSet extends StableSet<AtomId> {
	readonly #set: ReadonlySet<AtomId>;
	readonly #limit: number;
	readonly retainedBytes = 32;
	constructor(set: ReadonlySet<AtomId>, limit: number) {
		super();
		this.#set = set;
		this.#limit = limit;
	}
	has(id: AtomId): boolean {
		const seq = seqOf(id);
		return seq >= 0 && seq < this.#limit && this.#set.has(id);
	}
	*values(): SetIterator<AtomId> {
		for (const id of this.#set) {
			const seq = seqOf(id);
			if (seq >= 0 && seq < this.#limit) yield id;
		}
	}
}

/** The settler's push that was held for this collision, newest first: its message is that side's reason. */
function heldPush(project: Project, settle: Atom, file: string, after: number) {
	const held = project
		.refusals({ agent: settle.author, limit: 1000 })
		.refusals.find(
			(r) =>
				r.via === "publish" &&
				r.message !== undefined &&
				r.time <= settle.time &&
				r.time >= after &&
				r.collisions.some((c) => c.file === file),
		);
	return held ? { agent: held.agent, message: held.message!, time: held.time } : undefined;
}

/** One line: the change that wrote it, the publish behind it, its reasons, and what it settled. */
export function why(project: Project, asked: string, n: number, where: BlameWhere = {}) {
	const { file, all, view } = lines(project, asked, where);
	const line = all[n - 1];
	if (!line)
		throw Object.assign(new Error(`${file} has ${all.length} lines; ask for one in 1-${all.length}`), {
			code: "bad-request",
		});
	const graph = project.graph;
	const atom = graph.atom(line.atom);
	const publish = publishOf(project, atom.id);
	const reasons = atom.reasons.map((r) => ({
		kind: r.kind,
		text: r.text,
		to: r.to,
		toAuthor: graph.atom(r.to).author,
		toMessage: graph.atom(r.to).message,
	}));
	const reasonsIn: { from: AtomId; kind: string; text: string; fromAuthor: string; fromMessage: string }[] = [];
	for (const other of graph.atoms()) {
		for (const r of other.reasons) {
			if (r.to === atom.id)
				reasonsIn.push({
					from: other.id,
					kind: r.kind,
					text: r.text,
					fromAuthor: other.author,
					fromMessage: other.message,
				});
		}
	}
	// What it built on (#41, the line's story): the versions that brought in the changes it
	// depends on (its needs, and the changes whose lines it edited beside), nearest first, once each.
	const builtOn: { version: number; agent: string; message: string; draft?: string }[] = [];
	const own = publish ? `${publish.draft ?? ""} ${publish.version}` : undefined;
	const seen = new Set<string>(own ? [own] : []);
	for (const id of atom.deps) {
		const p = publishOf(project, id);
		if (!p || seen.has(`${p.draft ?? ""} ${p.version}`)) continue;
		seen.add(`${p.draft ?? ""} ${p.version}`);
		builtOn.push({
			version: p.version,
			agent: p.agent,
			message: p.message,
			...(p.draft !== null ? { draft: p.draft } : {}),
		});
	}
	builtOn.sort((a, b) =>
		(a.draft === undefined) !== (b.draft === undefined) ? (a.draft === undefined ? -1 : 1) : b.version - a.version,
	);
	// What it settled: its own change, or the settle that kept it (both sides of a block it sat in).
	const kept = atom.resolves.length === 0 ? keptThrough(project, view, file, line.id, atom) : undefined;
	const settle = kept ?? atom;
	const settled = settle.resolves.map((id) => {
		const a = graph.atom(id);
		return { atom: id, author: a.author, message: a.message, publish: publishOf(project, id) };
	});
	const held =
		settled.length > 0
			? heldPush(project, settle, file, Math.max(0, ...settled.map((s) => s.publish?.time ?? 0)))
			: undefined;
	const gitIssues = gitIssuesOf(project.sharedView());
	return {
		file,
		line: n,
		version: where.agent !== undefined ? null : (where.version ?? project.lastVersion(where.draft ?? null)),
		text: line.text,
		id: line.id,
		...(gitIssues !== undefined ? { gitIssues } : {}),
		change: {
			atom: atom.id,
			author: atom.author,
			message: atom.message,
			time: atom.time,
			needs: atom.needs,
			deps: atom.deps,
		},
		publish,
		reasons,
		reasonsIn,
		settled,
		...(kept ? { settledBy: { atom: kept.id, author: kept.author, publish: publishOf(project, kept.id) } } : {}),
		...(held ? { held } : {}),
		builtOn,
		...lineTrail(project, view, file, line.id),
	};
}

/**
 * The line's changes, newest first (abso-core issue 20), its own change
 * first: each change that rewrote it, with the line's text after it,
 * whether it only changed formatting, and the file it moved from, if it did. Several changes in one push count as
 * one, formatting only if all of them were.
 */
function lineTrail(project: Project, view: ReadView, file: string, line: LineId) {
	const graph = project.graph;
	// Changes pushed together: the same version of the same space, or both still in one agent's draft.
	const samePush = (a: Atom, b: Atom) => samePublish(publishOf(project, a.id), publishOf(project, b.id));
	const { steps, more } = trail(graph, view, file, line, undefined, samePush);
	const groups: { steps: TrailStep[]; publish: Publish | null }[] = [];
	for (const s of steps) {
		const publish = publishOf(project, s.atom);
		const prev = groups[groups.length - 1];
		if (
			prev &&
			samePublish(prev.publish, publish) &&
			(publish !== null || graph.atom(prev.steps[0]!.atom).author === graph.atom(s.atom).author)
		)
			prev.steps.push(s);
		else groups.push({ steps: [s], publish });
	}
	const out = groups.map(({ steps: [newest, ...rest], publish }) => {
		const a = graph.atom(newest!.atom);
		const oldest = rest[rest.length - 1] ?? newest!;
		const moved = [newest!, ...rest].some((s) => s.maybeMoved)
			? movedFrom(project, newest!.line, oldest.replaced, publish)
			: undefined;
		return {
			atom: a.id,
			author: a.author,
			message: a.message,
			time: a.time,
			text: newest!.text,
			formatting: [newest!, ...rest].every((s) => s.formatting),
			...(moved !== undefined ? { movedFrom: moved } : {}),
			publish,
		};
	});
	return { trail: out, ...(more ? { trailMore: true as const } : {}) };
}

/**
 * The file a push moved a line from: where the line it replaced was just
 * before the push, when that's not where the push left the line.
 */
function movedFrom(project: Project, line: LineId, replaced: LineId | undefined, publish: Publish | null) {
	if (replaced === undefined || publish === null || publish.version < 1) return undefined;
	const where = publish.draft === null ? {} : { draft: publish.draft };
	const fileIn = (version: number, id: LineId) => {
		try {
			return project.viewAt(version, where).fileOf(id);
		} catch {
			return undefined;
		}
	};
	const before = fileIn(publish.version - 1, replaced);
	const after = fileIn(publish.version, line);
	return before !== undefined && after !== undefined && before !== after ? before : undefined;
}

/** Where "#N" in history imported from git points (abso.json's "gitIssues"), when shared's project file says. */
function gitIssuesOf(view: ReadView): string | undefined {
	const file = projectFileIn(view);
	if (!file) return undefined;
	try {
		const url = (JSON.parse(file.text) as { gitIssues?: unknown }).gitIssues;
		return typeof url === "string" ? url : undefined;
	} catch {
		return undefined;
	}
}

function samePublish(a: Publish | null, b: Publish | null): boolean {
	return a === null || b === null ? a === b : a.draft === b.draft && a.version === b.version;
}

/**
 * Who wrote a folder (#41, F33): every line of every file under it (the
 * whole project for ""), counted by the agent that wrote it, most first.
 * Binary files and files kept whole have no lines, so they count as files
 * only. The folder is matched by any spelling.
 */
export function folderBlame(
	project: Project,
	folder: string,
	version?: number,
	where: Omit<BlameWhere, "version"> = {},
) {
	const { view, name } = viewOf(project, { version, ...where });
	const want = folder.split("/").filter((s) => s !== "" && s !== ".");
	const key = pathKey(want.join("/"));
	const graph = project.graph;
	const counts = new Map<string, number>();
	let files = 0;
	let total = 0;
	let stored: string | undefined;
	for (const path of view.paths()) {
		const parts = path.split("/");
		if (want.length > 0 && (parts.length <= want.length || pathKey(parts.slice(0, want.length).join("/")) !== key))
			continue;
		stored ??= parts.slice(0, want.length).join("/");
		files++;
		for (const l of view.lines(path)) {
			const author = graph.atom(l.atom).author;
			counts.set(author, (counts.get(author) ?? 0) + 1);
			total++;
		}
	}
	if (want.length > 0 && stored === undefined)
		throw Object.assign(new Error(`there is no folder ${want.join("/")} in ${name}`), { code: "not-found" });
	return {
		folder: stored ?? "",
		version: where.agent !== undefined ? null : (version ?? project.lastVersion(where.draft ?? null)),
		...(where.draft !== undefined ? { draft: where.draft } : {}),
		...(where.agent !== undefined ? { agent: where.agent } : {}),
		files,
		lines: total,
		authors: [...counts]
			.map(([agent, lines]) => ({ agent, lines }))
			.sort((a, b) => b.lines - a.lines || (a.agent < b.agent ? -1 : 1)),
	};
}
