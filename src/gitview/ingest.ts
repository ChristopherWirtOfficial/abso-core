// Plain git in: a person (or a plain agent) cloned a view, made ordinary git
// commits, and hands the repo back. Each commit is cut into atoms, one per
// hunk, with the default claims (the "fifteen parallel lines"): the hunks of
// one commit are written against the same state, so none depends on another.
// Each commit then gets a tie atom and a label, so the git history survives
// as labels.
//
// The commits sit on a base: the newest commit on the first-parent chain that
// is either a view commit (a View-Heads trailer naming atoms of this graph)
// or a commit an earlier ingest already took in (a tie atom carries its sha).
// The base set is the closure of those heads (or of that tie). When a view
// commit's tree isn't exactly the projection of its heads but its parent's
// is, a person amended it: the commit is ingested too, as their own change on
// top of its heads.
//
// The labels chain like git commits: commit i's tie needs its hunks and the
// tie before it (the first needs the base), and its label's base is the
// label before it. So closure(tie i) is exactly the state after commit i,
// and label i holds exactly commit i's hunks and tie.

import { type CommitObject, readCommit, resolveRef } from "isomorphic-git";
import {
	type Atom,
	type AtomId,
	type AtomSet,
	buildAtom,
	type Conflict,
	conflicts,
	diffLines,
	Graph,
	type Label,
	type Mode,
	project,
	sortBySeq,
	splitLines,
	View,
} from "../engine/index.ts";
import { GitViewError } from "./errors.ts";
import { headsOf, hunkLocation, labelName } from "./plain.ts";
import {
	GIT_COMMIT,
	parseTrailers,
	splitSubject,
	stripViewTrailers,
	trailerValue,
	VIEW_HEADS,
	withTrailers,
} from "./trailers.ts";
import { type GitContext, gitContext, readTreeFiles, type SkipReason, sameFiles, type TreeFiles } from "./tree.ts";

export { headsOf, hunkLocation, labelName };

export interface IngestOptions {
	/** Claim mode for every hunk atom. Default 'both', the git-like claims. */
	readonly mode?: Mode;
	/** Whose first-parent chain to ingest. Default "HEAD". */
	readonly ref?: string;
}

/** A file in a commit that can't be atoms' lines, listed once each time its content changes. */
export interface SkippedFile {
	readonly commit: string;
	readonly path: string;
	readonly reason: SkipReason;
}

export interface IngestBase {
	/**
	 * The commit the ingested commits sit on. When it is a view commit a person
	 * amended (its tree isn't the projection of its heads), it is also the
	 * first of `commits`.
	 */
	readonly commit: string;
	/**
	 * 'view': a view commit whose tree is the projection of its View-Heads.
	 * 'ingested': a commit an earlier ingest took in (ingesting again resumes there).
	 */
	readonly kind: "view" | "ingested";
	/** Maximal atoms of the base set. */
	readonly heads: readonly AtomId[];
	/**
	 * One atom whose closure is the base set, and the first label's base: the
	 * single head, an anchor (several heads), or the earlier tie. Missing only
	 * when nothing was ingested and the base has several heads but no anchor yet.
	 */
	readonly atom?: AtomId;
	/** The earlier ingest's label for the base commit ('ingested' kind), if it has one. */
	readonly label?: string;
	/** Set when the base has several heads: the atom that ties them, made by this ingest or an earlier one. */
	readonly anchor?: AtomId;
}

export interface IngestedCommit {
	/** Full sha of the git commit. */
	readonly commit: string;
	readonly label: string;
	readonly tie: AtomId;
	/** One atom per hunk, in path then position order. Empty when the commit changed no text. */
	readonly hunks: readonly AtomId[];
	readonly author: string;
	/** Author time in ms. */
	readonly time: number;
	readonly message: string;
}

export interface IngestResult {
	readonly base: IngestBase;
	/** Oldest first. */
	readonly commits: readonly IngestedCommit[];
	/** Every new atom (an anchor if one was made, then each commit's hunks and tie), in seq order. */
	readonly atoms: readonly Atom[];
	/** One per commit, oldest first. */
	readonly labels: readonly Label[];
	/** The shared set with the ingested state added. */
	readonly shared: Set<AtomId>;
	/** Atoms of the base that had left the shared set and came back because the ingested atoms need them. */
	readonly revived: readonly AtomId[];
	/** Conflicts in the new shared set that involve at least one atom that wasn't in it before. */
	readonly conflicts: readonly Conflict[];
	readonly skipped: readonly SkippedFile[];
}

interface Pending {
	readonly oid: string;
	readonly commit: CommitObject;
	readonly tree: TreeFiles;
}

interface FoundBase {
	readonly oid: string;
	readonly commit: CommitObject;
	readonly tree: TreeFiles;
	readonly kind: "view" | "ingested";
	/** 'view': maximal atoms of the View-Heads closure. 'ingested': the tie. */
	readonly heads: readonly AtomId[];
	/** Its tree is exactly the base set's projection (otherwise it is ingested too). */
	readonly exact: boolean;
}

/**
 * Ingest the commits a person made on top of a view. On success the new atoms
 * and labels are added to `graph` (nothing is added if it throws); the shared
 * set passed in is not changed, the updated one is returned. Nothing is
 * written to disk.
 */
export async function ingest(
	graph: Graph,
	sharedSet: AtomSet,
	repoDir: string,
	options: IngestOptions = {},
): Promise<IngestResult> {
	const mode = options.mode ?? "both";
	const ctx = gitContext(repoDir);

	// Read everything from git first, so a bad repo fails before any atom is built.
	const { base, pending } = await findBase(ctx, graph, options.ref ?? "HEAD");
	pending.reverse(); // oldest first

	const baseLabel = base.kind === "ingested" ? graph.labels().find((l) => l.head === base.heads[0])?.name : undefined;
	const existingAnchor = base.heads.length > 1 ? findAnchor(graph, base.heads) : undefined;

	if (pending.length === 0) {
		const atom = base.heads.length === 1 ? base.heads[0] : existingAnchor;
		return {
			base: {
				commit: base.oid,
				kind: base.kind,
				heads: base.heads,
				...(atom !== undefined ? { atom } : {}),
				...(baseLabel !== undefined ? { label: baseLabel } : {}),
				...(existingAnchor !== undefined ? { anchor: existingAnchor } : {}),
			},
			commits: [],
			atoms: [],
			labels: [],
			shared: new Set(sharedSet),
			revived: [],
			conflicts: [],
			skipped: [],
		};
	}

	// Build on a copy, then replay onto `graph`, so a failure leaves it untouched.
	const scratch = Graph.fromJSON(graph.toJSON());
	const added: Atom[] = [];
	const accept = (atom: Atom): Atom => {
		scratch.add(atom);
		const frozen = scratch.atom(atom.id);
		added.push(frozen);
		return frozen;
	};

	// The one atom the first label is based on.
	let anchor = existingAnchor;
	let baseAtom: AtomId;
	if (base.heads.length === 1) {
		baseAtom = base.heads[0]!;
	} else {
		if (anchor === undefined) {
			const view = new View(scratch, scratch.closureOf(base.heads));
			anchor = accept(
				buildAtom(view, {
					author: "ingest",
					message: anchorMessage(base.heads),
					time: base.commit.author.timestamp * 1000,
					needs: base.heads,
				}),
			).id;
		}
		baseAtom = anchor;
	}

	const state = scratch.closure(baseAtom);
	let view = new View(scratch, state);
	let prevAtom = baseAtom;
	let prevLabel = baseLabel;
	const labels: Label[] = [];
	const commits: IngestedCommit[] = [];
	const skipped: SkippedFile[] = [];
	// Skipped files are listed when they first appear or change, not in every commit.
	let skippedBefore = new Map(base.exact ? base.tree.skipped.map((s) => [s.path, s.oid]) : []);

	for (const p of pending) {
		const author = p.commit.author.name;
		const time = p.commit.author.timestamp * 1000;
		const message = stripViewTrailers(p.commit.message);
		const short = p.oid.slice(0, 7);

		// Binary files, symlinks and the like leave the projection's file as it
		// is; an emptied file loses all its lines (a projection has no empty files).
		const untouchable = new Set<string>();
		for (const s of p.tree.skipped) {
			if (s.reason !== "empty") untouchable.add(s.path);
			if (skippedBefore.get(s.path) !== s.oid) skipped.push({ commit: p.oid, path: s.path, reason: s.reason });
		}
		skippedBefore = new Map(p.tree.skipped.map((s) => [s.path, s.oid]));

		// One atom per hunk, all written against the state before this commit.
		const hunks: AtomId[] = [];
		const paths = [...new Set([...view.paths(), ...p.tree.files.keys()])].sort();
		for (const path of paths) {
			if (untouchable.has(path)) continue;
			const old = view.lines(path).map((l) => l.text);
			const text = p.tree.files.get(path);
			const next = text === undefined ? [] : splitLines(text);
			let shift = 0;
			for (const hunk of diffLines(old, next)) {
				const atom = buildAtom(view, {
					author,
					message: withTrailers(
						message,
						[{ key: "Hunk", value: hunkLocation(path, hunk, shift) }],
						`Commit ${short}`,
					).trimEnd(),
					time,
					edits: [{ file: path, start: hunk.start, end: hunk.end, lines: hunk.lines, mode }],
				});
				hunks.push(accept(atom).id);
				shift += hunk.lines.length - (hunk.end - hunk.start);
			}
		}
		for (const id of hunks) state.add(id);
		view = new View(scratch, state);

		// The tie: needs this commit's hunks and the state before it.
		const tie = accept(
			buildAtom(view, {
				author,
				message: withTrailers(message, [{ key: GIT_COMMIT, value: p.oid }], `Commit ${short}`).trimEnd(),
				time,
				needs: [...hunks, prevAtom],
			}),
		);
		state.add(tie.id);

		const { subject, body } = splitSubject(message);
		const name = labelName(scratch, p.oid);
		scratch.setLabel({
			name,
			head: tie.id,
			base: prevLabel ?? baseAtom,
			title: subject || `Commit ${short}`,
			message: body,
			...(prevLabel !== undefined ? { follows: [prevLabel] } : {}),
		});
		labels.push(scratch.label(name)!);
		commits.push({ commit: p.oid, label: name, tie: tie.id, hunks, author, time, message });
		prevAtom = tie.id;
		prevLabel = name;
	}

	// The shared set gains the whole ingested state (closure of the last tie).
	const isNew = new Set(added.map((a) => a.id));
	const shared = new Set(sharedSet);
	const revived: AtomId[] = [];
	for (const id of sortBySeq(scratch, state)) {
		if (shared.has(id)) continue;
		shared.add(id);
		if (!isNew.has(id)) revived.push(id);
	}
	const introduced = conflicts(scratch, shared).filter((c) => !sharedSet.has(c.atoms[0]) || !sharedSet.has(c.atoms[1]));

	// Everything worked: replay onto the caller's graph, and report its copies.
	for (const atom of added) graph.add(atom);
	for (const label of labels) graph.setLabel(label);

	return {
		base: {
			commit: base.oid,
			kind: base.kind,
			heads: base.heads,
			atom: baseAtom,
			...(baseLabel !== undefined ? { label: baseLabel } : {}),
			...(anchor !== undefined ? { anchor } : {}),
		},
		commits,
		atoms: added.map((a) => graph.atom(a.id)),
		labels: labels.map((l) => graph.label(l.name)!),
		shared,
		revived,
		conflicts: introduced,
		skipped,
	};
}

/**
 * Walk HEAD's first-parent chain back to the base. Returns the base and the
 * commits after it, newest first, with their trees already read.
 *
 * A commit is the base when an earlier ingest took it in, or when it carries
 * View-Heads naming atoms of this graph and its tree is exactly their
 * projection. A View-Heads commit whose tree differs is a view commit a
 * person amended only when its parent passes the exact test (that is what
 * shows the trailer belongs to this graph); it is then the base set and is
 * ingested too. Any other commit is the person's and the walk goes on.
 */
async function findBase(ctx: GitContext, graph: Graph, ref: string): Promise<{ base: FoundBase; pending: Pending[] }> {
	let oid: string;
	try {
		oid = await resolveRef({ fs: ctx.fs, dir: ctx.dir, ref });
	} catch (err) {
		throw new GitViewError("bad-repo", `can't resolve ${ref} in ${ctx.dir}: ${(err as Error).message}`);
	}
	const ties = tiesByCommit(graph);
	const seen = new Map<string, Classified>();
	const classify = async (oid: string): Promise<Classified> => {
		let c = seen.get(oid);
		if (!c) {
			c = await classifyCommit(ctx, graph, ties, oid);
			seen.set(oid, c);
		}
		return c;
	};

	const pending: Pending[] = [];
	for (;;) {
		const c = await classify(oid);
		if (c.kind === "ingested" || c.kind === "view") {
			return { base: { oid, commit: c.commit, tree: c.tree, kind: c.kind, heads: c.heads, exact: true }, pending };
		}
		const parent = c.commit.parent[0];
		if (c.kind === "amended-view" && parent !== undefined) {
			const p = await classify(parent);
			if (p.kind === "ingested" || p.kind === "view") {
				pending.push({ oid, commit: c.commit, tree: c.tree });
				return { base: { oid, commit: c.commit, tree: c.tree, kind: "view", heads: c.heads, exact: false }, pending };
			}
		}
		pending.push({ oid, commit: c.commit, tree: c.tree });
		if (parent === undefined) {
			throw new GitViewError(
				"no-view-base",
				`no commit on the first-parent chain of ${ref} is a view of this graph (View-Heads naming its atoms, with their projection as its tree) or an ingested commit`,
			);
		}
		oid = parent;
	}
}

interface Classified {
	readonly commit: CommitObject;
	readonly tree: TreeFiles;
	/**
	 * ingested: an earlier ingest's tie carries its sha. view: View-Heads of
	 * this graph and the tree is their projection. amended-view: View-Heads
	 * naming atoms of this graph, but the tree differs. plain: anything else.
	 */
	readonly kind: "ingested" | "view" | "amended-view" | "plain";
	readonly heads: readonly AtomId[];
}

async function classifyCommit(
	ctx: GitContext,
	graph: Graph,
	ties: ReadonlyMap<string, AtomId>,
	oid: string,
): Promise<Classified> {
	let commit: CommitObject;
	try {
		({ commit } = await readCommit({ fs: ctx.fs, dir: ctx.dir, oid, cache: ctx.cache }));
	} catch (err) {
		throw new GitViewError(
			"no-view-base",
			`reached commit ${oid}, which can't be read (${(err as Error).message}), without finding a view commit`,
		);
	}
	const tree = await readTreeFiles(ctx, commit.tree);
	const tie = ties.get(oid);
	if (tie !== undefined) return { commit, tree, kind: "ingested", heads: [tie] };
	const value = trailerValue(parseTrailers(commit.message), VIEW_HEADS);
	const ids = (value ?? "").split(/\s+/).filter((s) => s !== "");
	if (ids.length === 0 || !ids.every((id) => graph.has(id))) return { commit, tree, kind: "plain", heads: [] };
	const set = graph.closureOf(ids);
	const exact = tree.skipped.length === 0 && sameFiles(tree.files, project(graph, set));
	return { commit, tree, kind: exact ? "view" : "amended-view", heads: headsOf(graph, set) };
}

/** Tie atoms of earlier ingests and pushes, by the full sha of the git commit they stand for. A pushed tie may hold lines (Relies-On). */
function tiesByCommit(graph: Graph): Map<string, AtomId> {
	const out = new Map<string, AtomId>();
	for (const atom of graph.atoms()) {
		if (atom.inserts.length > 0 || atom.deletes.length > 0) continue;
		const sha = trailerValue(parseTrailers(atom.message), GIT_COMMIT);
		if (sha !== undefined && !out.has(sha)) out.set(sha, atom.id);
	}
	return out;
}

function anchorMessage(heads: readonly AtomId[]): string {
	return `Base of a git view: ${heads.join(" ")}`;
}

/** An anchor an earlier ingest made for the same heads: no edits or claims, needs exactly the heads. */
function findAnchor(graph: Graph, heads: readonly AtomId[]): AtomId | undefined {
	const message = anchorMessage(heads);
	const want = [...heads].sort().join(" ");
	for (const atom of graph.atoms()) {
		if (atom.message !== message || atom.inserts.length > 0 || atom.deletes.length > 0) continue;
		if (atom.holds.length > 0 || atom.resolves.length > 0 || atom.reasons.length > 0) continue;
		if ([...atom.needs].sort().join(" ") === want) return atom.id;
	}
	return undefined;
}
