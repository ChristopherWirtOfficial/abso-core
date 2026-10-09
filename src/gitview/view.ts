// The git view: a real git repo for a set of atoms. Each commit's tree is the
// projection of a closed set, and its message carries trailers naming the
// atoms, so the same set and options always give the same commit hashes.
//
// Two shapes:
// - per atom (the default): one commit per atom in history order. Every
//   prefix of history order is closed, so every commit is a real state.
// - by label: a root commit for a0, then one commit per label whose head is
//   in the set (each adds the label's closure), then one commit for whatever
//   no label covered.
// Commit sets only grow, so each commit's set is a prefix of one order (the
// plan's `order`) and a commit records only how long its prefix is.

import fs from "node:fs";
import { checkout, init, writeCommit, writeRef } from "isomorphic-git";
import {
	type Atom,
	type AtomId,
	type Graph,
	history,
	isClosed,
	missingDeps,
	project,
	sortBySeq,
	stateOf,
} from "../engine/index.ts";
import { GitViewError } from "./errors.ts";
import { type Trailer, VIEW_HEADS, withTrailers } from "./trailers.ts";
import { gitContext, writeCache, writeFilesTree } from "./tree.ts";

/** A ref (atom id or label name: its closure) or an explicit closed set of atoms. */
export type ViewTarget = string | Iterable<AtomId>;

export interface ViewOptions {
	/** One commit per label instead of one per atom. */
	readonly byLabel?: boolean;
	/** Branch to write; HEAD points at it. Default "main". */
	readonly branch?: string;
	/** Check the branch out into the directory's working tree. Default true. */
	readonly checkout?: boolean;
}

export interface ViewCommitPlan {
	/** Atoms this commit adds, in history order. */
	readonly atoms: readonly AtomId[];
	/** Size of this commit's set: it is `order.slice(0, count)` of the plan. */
	readonly count: number;
	/** Maximal atoms of this commit's set (no atom in the set depends on them), by seq. */
	readonly heads: readonly AtomId[];
	/** The label this commit stands for (by-label mode). */
	readonly label?: string;
	/** Full commit message, trailers included. */
	readonly message: string;
	/** Git author name and time (ms) of the commit. */
	readonly author: string;
	readonly time: number;
}

export interface ViewPlan {
	/** Every atom of the set, in the order commits add them. */
	readonly order: readonly AtomId[];
	readonly commits: readonly ViewCommitPlan[];
}

export interface ViewCommit {
	readonly oid: string;
	readonly atoms: readonly AtomId[];
	readonly heads: readonly AtomId[];
	readonly label?: string;
	readonly message: string;
}

export interface ViewResult {
	readonly dir: string;
	readonly branch: string;
	/** The tip commit (what the branch and HEAD point at). */
	readonly head: string;
	/** The whole set, by seq. */
	readonly set: readonly AtomId[];
	/** Oldest first. */
	readonly commits: readonly ViewCommit[];
}

/** Domain for derived author emails (.invalid is reserved: it can never be a real address). */
export const EMAIL_DOMAIN = "atoms.invalid";

/**
 * Resolve a target to a closed set. A string is a ref (its closure); anything
 * else is an explicit set, which must be closed.
 */
export function resolveTarget(graph: Graph, target: ViewTarget): Set<AtomId> {
	let set: Set<AtomId>;
	if (typeof target === "string") {
		set = new Set(stateOf(graph, target));
	} else {
		set = new Set(target);
		for (const id of set) graph.atom(id); // unknown ids throw EngineError('unknown-atom')
		if (!isClosed(graph, set)) {
			const missing = missingDeps(graph, set)
				.map((m) => `${m.atom} needs ${m.missing.join(", ")}`)
				.join("; ");
			throw new GitViewError("not-closed", `the set is not closed: ${missing}`);
		}
	}
	if (set.size === 0) throw new GitViewError("empty-set", "there are no atoms to view");
	return set;
}

/**
 * Plan the commits of a view without touching any disk: which atoms each
 * commit adds, its heads, author, time and message. Pure: the same set and
 * options give the same plan, whatever order the set was listed in.
 */
export function planView(graph: Graph, target: ViewTarget, options: Pick<ViewOptions, "byLabel"> = {}): ViewPlan {
	const set = resolveTarget(graph, target);
	const order: AtomId[] = [];
	const heads = new Set<AtomId>();
	const commits: ViewCommitPlan[] = [];

	// Add atoms to the running set. Each atom's deps are already in it (atoms
	// come in history order, and the running set is closed), so the atom is a
	// new head and its deps stop being heads.
	const addAll = (atoms: readonly Atom[]): void => {
		for (const atom of atoms) {
			for (const d of atom.deps) heads.delete(d);
			heads.add(atom.id);
			order.push(atom.id);
		}
	};
	const headList = (): AtomId[] => sortBySeq(graph, heads);

	if (!options.byLabel) {
		for (const atom of history(graph, set)) {
			addAll([atom]);
			const h = headList();
			commits.push({
				atoms: [atom.id],
				count: order.length,
				heads: h,
				message: atomMessage(atom, h),
				author: atom.author,
				time: atom.time,
			});
		}
		return { order, commits };
	}

	const covered = new Set<AtomId>();
	const take = (ids: Iterable<AtomId>): Atom[] => {
		const fresh = history(
			graph,
			[...ids].filter((id) => !covered.has(id)),
		);
		for (const atom of fresh) covered.add(atom.id);
		addAll(fresh);
		return fresh;
	};

	// The starting snapshot is the root commit.
	if (set.has("a0")) {
		const [a0] = take(["a0"]);
		const h = headList();
		commits.push({
			atoms: ["a0"],
			count: order.length,
			heads: h,
			message: atomMessage(a0!, h),
			author: a0!.author,
			time: a0!.time,
		});
	}

	// Labels in the order of their heads' priority: a label whose head is in
	// another's closure has the lower priority, so it comes first.
	const labels = graph
		.labels()
		.filter((l) => set.has(l.head))
		.sort((a, b) => graph.comparePriority(a.head, b.head) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const label of labels) {
		const fresh = take(graph.closure(label.head));
		const h = headList();
		// Author and time of the commit are its last atom's (normally the label's head).
		const last = fresh[fresh.length - 1] ?? graph.atom(label.head);
		const ids = fresh.map((a) => a.id);
		const trailers: Trailer[] = [
			{ key: "Label", value: label.name },
			...(ids.length > 0 ? [{ key: "Atoms", value: ids.join(" ") }] : []),
			...fresh.flatMap(reasonTrailers),
			{ key: VIEW_HEADS, value: h.join(" ") },
		];
		const text = label.message.trim() !== "" ? `${label.title}\n\n${label.message}` : label.title;
		commits.push({
			atoms: ids,
			count: order.length,
			heads: h,
			label: label.name,
			message: withTrailers(text, trailers, `Label ${label.name}`),
			author: last.author,
			time: last.time,
		});
	}

	// Whatever no label covered.
	const rest = [...set].filter((id) => !covered.has(id));
	if (rest.length > 0) {
		const fresh = take(rest);
		const h = headList();
		const last = fresh[fresh.length - 1]!;
		const trailers: Trailer[] = [
			{ key: "Atoms", value: fresh.map((a) => a.id).join(" ") },
			...fresh.flatMap(reasonTrailers),
			{ key: VIEW_HEADS, value: h.join(" ") },
		];
		commits.push({
			atoms: fresh.map((a) => a.id),
			count: order.length,
			heads: h,
			message: withTrailers("Atoms outside any label", trailers, ""),
			author: last.author,
			time: last.time,
		});
	}
	return { order, commits };
}

/** A per-atom commit message: the atom's message, then Atom, Deps, Resolves, Reason and View-Heads trailers. */
function atomMessage(atom: Atom, heads: readonly AtomId[]): string {
	const trailers: Trailer[] = [{ key: "Atom", value: atom.id }];
	if (atom.deps.length > 0) trailers.push({ key: "Deps", value: atom.deps.join(" ") });
	if (atom.resolves.length > 0) trailers.push({ key: "Resolves", value: atom.resolves.join(" ") });
	trailers.push(...reasonTrailers(atom));
	trailers.push({ key: VIEW_HEADS, value: heads.join(" ") });
	return withTrailers(atom.message, trailers, `Atom ${atom.id}`);
}

/** One "Reason: <from> <kind> <to>: <text>" trailer per reason the atom carries. */
function reasonTrailers(atom: Atom): Trailer[] {
	return atom.reasons.map((r) => ({ key: "Reason", value: `${atom.id} ${r.kind} ${r.to}: ${r.text}` }));
}

/** A git author name: no angle brackets or line breaks (git can't store them), never empty. */
export function gitName(author: string): string {
	return author.replace(/[<>\r\n]/g, "").trim() || "unknown";
}

/** A deterministic email for an author name: a lowercase slug at atoms.invalid. */
export function gitEmail(author: string): string {
	const slug = author
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return `${slug || "unknown"}@${EMAIL_DOMAIN}`;
}

/** Author and committer of a view commit: the atom's author at the atom's time (seconds, UTC). */
function signature(
	author: string,
	time: number,
): { name: string; email: string; timestamp: number; timezoneOffset: number } {
	return {
		name: gitName(author),
		email: gitEmail(author),
		timestamp: Math.max(0, Math.floor(time / 1000)),
		timezoneOffset: 0,
	};
}

/**
 * Write a git repo at `dir` (which must be missing or empty) for the set.
 * Each commit's tree is the projection of its set; HEAD points at `branch`.
 */
export async function writeView(
	graph: Graph,
	target: ViewTarget,
	dir: string,
	options: ViewOptions = {},
): Promise<ViewResult> {
	const plan = planView(graph, target, options);
	const branch = options.branch ?? "main";

	if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
		throw new GitViewError("dir-not-empty", `${dir} already has files in it`);
	}
	fs.mkdirSync(dir, { recursive: true });
	const ctx = gitContext(dir);
	await init({ fs, dir, defaultBranch: branch });

	const cache = writeCache();
	const commits: ViewCommit[] = [];
	let parent: string | undefined;
	for (const c of plan.commits) {
		const tree = await writeFilesTree(ctx, project(graph, plan.order.slice(0, c.count)), cache);
		const sig = signature(c.author, c.time);
		const oid = await writeCommit({
			fs,
			dir,
			commit: { message: c.message, tree, parent: parent ? [parent] : [], author: sig, committer: sig },
		});
		commits.push({
			oid,
			atoms: c.atoms,
			heads: c.heads,
			...(c.label !== undefined ? { label: c.label } : {}),
			message: c.message,
		});
		parent = oid;
	}
	await writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: parent!, force: true });
	if (options.checkout !== false) await checkout({ fs, dir, ref: branch, force: true, cache: ctx.cache });

	return { dir, branch, head: parent!, set: sortBySeq(graph, plan.order), commits };
}
