// Take in commits a person pushed with plain git. Writes go through IngestHost; today the host is Project.

import { type AtomId, canonicalText, type Hunk, type ReadView } from "../../src/engine/index.ts";
import { checkPath } from "./path-rules.ts";
import { ProjectError } from "./project-error.ts";
import { configProblem, PROJECT_FILES } from "./project-helpers.ts";
import type { AgentState, Entry, IngestAnswer, LandAnswer, Meta, Mode, Modes, PublishAnswer } from "./project-types.ts";
import type { Space } from "./spaces.ts";
import { clashInPaths } from "./spelling.ts";

/** What taking in a git push needs from a project. */
export interface IngestHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	readonly spaces: ReadonlyMap<string, Space>;
	needInit(): void;
	version(): number;
	checkBlobs(blobs: unknown, files: object): Record<string, string>;
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
	wholeOut(
		files: Readonly<Record<string, string | null>>,
		blobs: Readonly<Record<string, string>>,
		view: ReadView | undefined,
		config?: string,
	): { files: Record<string, string | null>; blobs: Record<string, string> };
	agentView(agent: AgentState): ReadView;
	recordFile(
		agent: AgentState,
		view: ReadView,
		path: string,
		text: string | null | undefined,
		time: number,
		meta: Meta,
		entries: Entry[],
		mode?: Mode,
		blob?: string,
		hunks?: readonly Hunk[],
	): boolean;
	publish(
		agent: AgentState,
		message: string,
		time: number,
		entries: Entry[],
		asIs?: boolean,
		direct?: boolean,
	): PublishAnswer;
	land(
		agent: AgentState,
		message: string,
		time: number,
		entries: Entry[],
		pick?: { space: Space; changes: AtomId[] },
	): LandAnswer;
}

/**
 * Take in commits a person pushed with plain git (demo moment 5, #5, #8).
 * `base` is the shared version their first commit builds on (the
 * `avcs-version` of the commit they cloned). Each commit gives its whole
 * tree as text; a file of the view missing from it is deleted. The commits
 * go into a named draft `git-<sha>` on that version, one publish each, and
 * the draft lands in shared at once if nothing collides. The push already
 * happened, so a collision isn't refused: the draft waits, with its
 * collisions listed, for someone to switch to it, settle and land it.
 */
export function ingest(
	host: IngestHost,
	input: {
		author: string;
		base: number;
		commits: readonly {
			sha: string;
			message: string;
			files: Readonly<Record<string, string>>;
			modes?: Modes;
			blobs?: Readonly<Record<string, string>>;
		}[];
	},
	time: number,
): IngestAnswer {
	host.needInit();
	if (typeof input !== "object" || input === null || !Array.isArray(input.commits) || input.commits.length === 0) {
		throw new ProjectError("bad-request", "ingest needs {author, base, commits: [{sha, message, files}]}");
	}
	if (!Number.isInteger(input.base) || input.base < 0 || input.base > host.version()) {
		throw new ProjectError("bad-request", `base ${String(input.base)} is not a shared version`);
	}
	for (const c of input.commits) {
		if (typeof c?.sha !== "string" || !/^[0-9a-f]{7,64}$/.test(c.sha))
			throw new ProjectError("bad-request", "each commit needs a hex sha");
		if (typeof c.message !== "string" || typeof c.files !== "object" || c.files === null) {
			throw new ProjectError("bad-request", "each commit needs a message and files");
		}
		for (const path of Object.keys(c.files)) {
			checkPath(path);
			if (typeof c.files[path] !== "string")
				throw new ProjectError("bad-request", `${path}: file text must be a string`);
		}
		if (c.blobs !== undefined) host.checkBlobs(c.blobs, c.files);
		const clash = clashInPaths([...new Set([...Object.keys(c.files), ...Object.keys(c.blobs ?? {})])].toSorted());
		if (clash)
			throw new ProjectError(
				"conflict",
				`commit ${c.sha.slice(0, 12)}: ${clash} (#49); rename one with git mv and push again`,
			);
		for (const name of PROJECT_FILES) {
			const config = typeof c.files[name] === "string" ? configProblem(c.files[name]) : undefined;
			if (config)
				throw new ProjectError("conflict", `commit ${c.sha.slice(0, 12)}: ${name} ${config}; fix it and push again`);
		}
	}
	const name = `git-${input.commits[0]!.sha.slice(0, 12)}`;
	if (host.agents.has(name) || host.spaces.has(name)) {
		throw new ProjectError("bad-request", `commit ${input.commits[0]!.sha.slice(0, 12)} was already taken in`);
	}
	const entries: Entry[] = [];
	for (const e of [
		{ type: "join", agent: name, version: input.base },
		{ type: "space", name, agent: name, time, sharedBase: input.base },
		{ type: "switch", agent: name, space: name, version: 0, carry: false },
	] as Entry[]) {
		entries.push(e);
		host.apply(e);
	}
	const agent = host.agents.get(name)!;
	const author = typeof input.author === "string" && input.author.trim() !== "" ? input.author.trim() : "git";
	const about = (c: { sha: string; message: string }): string =>
		`${c.message.trim()}\n\nGit-Commit: ${c.sha}\nAuthor: ${author}`;
	for (const original of input.commits) {
		const out = host.wholeOut(original.files, original.blobs ?? {}, host.agentView(agent));
		const commit = { ...original, files: out.files as Record<string, string> };
		const blobs = out.blobs;
		const paths = new Set([...host.agentView(agent).paths(), ...Object.keys(commit.files), ...Object.keys(blobs)]);
		for (const path of [...paths].toSorted()) {
			const text = commit.files[path];
			const blob = blobs[path];
			// With modes, the commit's whole set: a file not listed is plain. Without, modes stay as they were.
			const mode: Mode | undefined = commit.modes
				? { exec: commit.modes[path]?.exec === true, link: commit.modes[path]?.link ?? null }
				: undefined;
			const target = blob !== undefined ? "" : text === undefined ? null : canonicalText(text);
			host.recordFile(agent, host.agentView(agent), path, target, time, {}, entries, mode, blob);
		}
		// A git push can't answer a refusal mid-way, so each commit goes as it is, straight into its named draft.
		host.publish(agent, about(commit), time, entries, true, true);
	}
	const landed = host.land(agent, about(input.commits[input.commits.length - 1]!), time, entries);
	host.flush(entries);
	return landed.ok
		? { landed: true, version: landed.version, draft: name, changes: landed.changes }
		: { landed: false, version: host.version(), draft: name, collisions: landed.collisions };
}
