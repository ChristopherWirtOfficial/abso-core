// The calls a server makes into a project, over the engine (#20): answer()
// in http.ts takes a route to one of these. Any server built on the engine
// implements them; the hosted Worker's is EngineProject (abso issue 141).

/** An Edit, a Write or a MultiEdit, as the hook sends it. */
export type EditBody = {
	file: string;
	session?: string;
	subagent?: string;
} & ({ old: string; new: string } | { content: string } | { edits: { old: string; new: string }[] });

/** Files that aren't plain: executable, or a symbolic link to `link` (#27). */
export type FileModes = Record<string, { exec?: boolean; link?: string | null }>;

export interface Collision {
	file: string;
	yours: { lines: [number, number]; text: string };
	theirs: { agent: string; message: string; version: number; lines: [number, number]; text: string };
}

export interface ProjectCalls {
	/** blobs (#27): binary files, path -> the SHA-256 of bytes already uploaded to PUT /p/:project/blobs/<sha256>. */
	init(
		files: Record<string, string>,
		modes?: Record<string, { exec?: boolean; link?: string | null }>,
		blobs?: Record<string, string>,
	): { version: number; skipped?: string[] };
	edit(agent: string, body: EditBody): { ok: true; news: string[] } | { ok: false; reason: "out of step" };
	record(
		agent: string,
		files: Record<string, string | null>,
		modes?: Record<string, { exec?: boolean; link?: string | null }>,
		blobs?: Record<string, string>,
		meta?: { session?: string; subagent?: string; client?: string },
	): { ok: true; changed: string[]; news: string[] };
	publish(
		agent: string,
		message: string,
		asIs?: boolean,
	):
		| { ok: true; version: number; changes?: number }
		| { ok: true; queued: number; position: number; ahead: number; changes: number }
		| { ok: false; collisions: unknown[] };
	sync(agent: string): { version: number; files: Record<string, string | null>; collisions: unknown[] };
	status(): {
		version: number;
		agents: {
			agent: string;
			draft?: string | null;
			base: number;
			draftChanges: number;
			files: string[];
			parked?: { draft: string | null; draftChanges: number }[];
		}[];
		drafts?: { name: string; version: number; sharedBase: number; changes: number; agents: string[] }[];
	};
	/** Named drafts (#10): move to a named draft, or back to shared with null, parking unpublished changes; carry takes them into a new draft. Answers like a sync. */
	switchTo(
		agent: string,
		name: string | null,
		carry?: boolean,
	): { draft: string | null; version: number; files: Record<string, string | null>; collisions: unknown[] };
	/** Lands the agent's named draft in shared as one unit. Answers like publish. */
	land(
		agent: string,
		message: string,
	): { ok: true; version: number; changes?: number } | { ok: false; collisions: unknown[] };
	/** Moves the agent's named draft onto shared's newest version. */
	syncDraft(agent: string): { draft: string; version: number; sharedBase: number };
	/** Commits pushed to the project's repo with plain git (#8). See the engine's ingest. */
	ingest(
		input: {
			author: string;
			base: number;
			commits: {
				sha: string;
				message: string;
				files: Record<string, string>;
				modes?: FileModes;
				blobs?: Record<string, string>;
			}[];
		},
		time: number,
	): { landed: boolean; version: number; draft: string };
	/** Shared's files now, for the push out to Artifacts. A link's text is "" and its target is in modes. */
	/** Shared's text files at an earlier version (#31: pinning a reviewed harness). */
	filesAt(version: number): Record<string, string>;
	/** Shared's binary files at `version`: path -> SHA-256. */
	blobsAt(version: number): Record<string, string>;
	shared(): {
		version: number;
		files: Record<string, string>;
		modes?: FileModes;
		blobs?: Record<string, string>;
		last?: { agent: string; message: string };
	};
	/** Whether init has run. */
	exists(): boolean;
}

/** Reading shared's history (slice 2): blame for a file, why for one line. See blame.ts. */
export interface ProjectHistory {
	/** draft: a named draft's view (at version); agent: an agent's view now, its unpublished changes included. */
	blame(file: string, from?: number, to?: number, version?: number, draft?: string, agent?: string): unknown;
	why(file: string, line: number, draft?: string, agent?: string, version?: number): unknown;
	/** Who wrote a folder: its lines counted by author (#41, F33). */
	folderBlame(folder: string, version?: number, draft?: string, agent?: string): unknown;
	/** One folder's entries with each one's last change (#41, F2, F34). */
	tree(folder: string, version?: number, draft?: string | null, agent?: string, authors?: boolean): unknown;
	/** A path's life: its last change, and the versions that made it and took it out (#41, F10, F30). */
	pathLife(path: string, version?: number, draft?: string | null): unknown;
	/** Lines at one version followed by their ids to a later one (#41, F15). */
	follow(path: string, version: number, from: number, to: number, at?: number, draft?: string | null): unknown;
	/** An agent's paths for a reader: an unknown agent is not found, and nothing is made (#41, F25). */
	pathsOf(agent: string): unknown;
	/** Whether agents' unpublished changes would collide, by the publish rule (#41, F22). */
	collisions(file?: string, folder?: string): unknown;
	draftState(name: string): unknown;
	/** Who is working where: each file, the agents whose drafts touch it, and which lines. */
	where(): unknown;
	/** The versions of shared (or a named draft), newest first (#27); follow: a path's history back through abso mv (#41, F27). */
	log(draft: string | null, limit?: number, path?: string, agent?: string, before?: number, follow?: boolean): unknown;
	/** The project's events from a log position (#41, the website): reading consumes nothing. */
	feed(from: number, limit?: number): { next: number; end: number; events: unknown[] };
	/** How many entries the log holds: what a feed long-poll waits to see grow. */
	logLength(): number;
	/** An agent's draft diff for a reader: never creates the agent (#41). */
	diffOf(agent: string): unknown;
	/** Every agent with unpublished changes (#41). */
	drafts(): unknown;
	/** One change (#44): its start note or draft, versions, files, settles and refusals. */
	change(id: number): unknown;
	/** The changes with anything new at or after a log position (#44, "since you last looked"). */
	changes(since: number, limit: number, before?: number, issue?: number): unknown;
	/** Move a file in the agent's draft, its lines keeping their ids (#49). */
	move(agent: string, from: string, to: string): unknown;
	/** A note on lines, or a reply to one (#44). */
	note(agent: string, body: Record<string, unknown>): unknown;
	/** A signed-in person's note from the website (#41); the Worker has checked who it is. No HTTP route. */
	notePerson(person: { id: string; name: string }, body: Record<string, unknown>): unknown;
	/** Close a person's own note (#41). No HTTP route. */
	closeNotePerson(person: { id: string; name: string }, id: number, how: unknown): unknown;
	/** Close a note; only its writer can (#44). */
	closeNote(agent: string, id: number, how: unknown): unknown;
	/** Notes on a file or a change, or only the open ones (#44). */
	notes(options: { file?: string; change?: number; open?: boolean }): unknown;
	/** The log position for a time (ms since 1970) or a version of shared (#41). */
	position(q: { time?: number; version?: number }): { position: number; end: number };
	/** Shared's versions as authors only, for the website's ribbon (#43). */
	ribbon(): { version: number; agents: string[]; authors: number[] };
	/** status and where as they stood with the first `at` log entries (#41, replay). */
	statusAt(at: number): unknown;
	whereAt(at: number): unknown;
	/** Refused publishes and lands, newest first, with counts over all of them. */
	refusals(agent?: string, limit?: number): unknown;
	/** A file as it was at a version (#27). */
	fileAt(path: string, version: number, draft: string | null, agent?: string): unknown;
	/** Every file that differs between two versions (#27). */
	compare(from: number, to: number, draft: string | null, agent?: string, summary?: boolean): unknown;
	/** Version `version` of shared without the versions in `versions` (without.ts). */
	without(version: number, versions: readonly number[]): unknown;
	/** One version: who, why, and each file before and after (#27). */
	show(version: number, draft: string | null, agent?: string): unknown;
	/** What an agent's unpublished changes do, file by file (#27). */
	diff(agent: string): unknown;
	/** A sync whose answer holds every file in the agent's view, as a first sync's does (#37). */
	syncFull(agent: string, label?: string): unknown;
	/** The paths in the agent's view now; changes nothing (#37). */
	agentPaths(agent: string): unknown;
	/** The paths in shared (or a named draft) at a version, the newest by default (#37). */
	pathsAt(version?: number, draft?: string | null): unknown;
	/** Sync to the newest version of shared with a label (#10). */
	syncTo(agent: string, label: string): unknown;
	/** Put a label on a version of shared (the newest by default), or take it off. */
	label(agent: string, name: string, version?: number, remove?: boolean): unknown;
	/** Every label, with the versions it marks, newest first. */
	labels(): unknown;
	/** Correct the message of the agent's newest publish (#27). */
	amend(agent: string, message: string): unknown;
	/** Take some versions of a named draft into shared, checked like a land (#27). */
	pluck(agent: string, draft: string, versions: number[], message: string, withDependencies?: boolean): unknown;
	/** Drop published versions of shared (#10): a new version whose set leaves them out, with what built on them. */
	drop(agent: string, versions: number[], message: string, withDependents?: boolean): unknown;
	/** News for other agents: "Announcement from <agent>: <text>"; `to` defaults to every other agent. */
	announce(agent: string, text: string, to?: string[], how?: string): { id: number; to: string[] };
	/** A signed-in person's announcement from the website (#41): the Worker has checked the sender. */
	announcePerson(person: { id: string; name: string }, text: string, to?: string[]): { id: number; to: string[] };
	/** What the agent is starting on (#37, #13), or null to take it back; answers who already works on those files. */
	starting(
		agent: string,
		text: string | null,
		files?: string[],
		options?: { issue?: unknown; done?: unknown },
	): unknown;
	/** Hands over the news waiting for an agent, once. */
	news(agent: string): { news: string[] };
	/** Discard an agent's unpublished changes to some files, or all (#27). */
	restore(agent: string, files: string[] | null): unknown;
}
