import type { Atom, AtomId, LineId } from "../../src/engine/index.ts";
import type { Kept, MarkedRegion } from "./markers.ts";
/** Whole files: path -> text, or null for a deleted file. */
export type Files = Record<string, string | null>;

/** A file's mode: executable, or a symbolic link to `link`. Only the fields given change. */
export interface Mode {
	exec?: boolean;
	link?: string | null;
}
export type Modes = Record<string, Mode>;

/** What the project stores, in order. Plain JSON. A missing `space` means shared. */
export type Entry =
	| { readonly type: "init"; readonly atom: Atom; readonly time: number }
	| { readonly type: "join"; readonly agent: string; readonly version: number; readonly time?: number }
	| {
			readonly type: "draft";
			readonly agent: string;
			readonly atom: Atom;
			readonly session?: string;
			readonly subagent?: string;
			/** The client that sent it (#41, the edits mark): its X-Avcs-Client, such as avcs-mod/0.1.0+702c616. */
			readonly client?: string;
	  }
	| {
			readonly type: "publish";
			readonly agent: string;
			/** The named draft published into; absent for shared. */
			readonly space?: string;
			readonly version: number;
			readonly message: string;
			readonly time: number;
			/** The draft changes that joined the space, in the order they were made. */
			readonly changes: readonly AtomId[];
			/** Needs every change, carries the message, and settles what the agent had seen collide. */
			readonly tie: Atom;
			/** True when nobody else published since the agent's base, so its base moves to this version. */
			readonly rebase: boolean;
			/** Marked collisions (#11) this publish settled, and what was kept: logged so keeping both is on record. */
			readonly settled?: readonly Settled[];
			/** The merge queue's id when this landed from the queue (#39). */
			readonly queued?: number;
			/**
			 * The change it belongs to (#44): the log position of the entry that
			 * began it. Entries written before changes existed have none, and their
			 * publish ended the agent's start note.
			 */
			readonly change?: number;
	  }
	/**
	 * A publish waiting in the merge queue (#39): the changes it takes, what it
	 * settles, and the message. It lands as an ordinary publish once its batch
	 * passes the project's check, or is pulled.
	 */
	| {
			readonly type: "queued";
			readonly agent: string;
			readonly id: number;
			readonly message: string;
			readonly time: number;
			readonly changes: readonly AtomId[];
			readonly resolves: readonly AtomId[];
			readonly settled?: readonly Settled[];
			readonly change?: number;
	  }
	/**
	 * A note on lines (#44): anchored to the lines' ids, so it stays on the
	 * code it's about while the file changes around it. A reply carries the
	 * note it answers, and its file and lines.
	 */
	| {
			readonly type: "note";
			readonly id: number;
			readonly agent: string;
			readonly kind: NoteKind;
			readonly file: string;
			readonly lines: readonly LineId[];
			readonly text: string;
			readonly change?: number;
			readonly reply?: number;
			readonly time: number;
			/** A signed-in person wrote it on the website (#41): then `agent` is "person:<id>", never an agent's name. */
			readonly person?: PersonSender;
	  }
	/** A note closed by its writer (#44); `person` as on the note. */
	| {
			readonly type: "note-closed";
			readonly id: number;
			readonly agent: string;
			readonly how: "resolved" | "withdrawn";
			readonly time: number;
			readonly person?: PersonSender;
	  }
	/** A queued publish taken out (#39): its check failed, it built on one that did, or its author withdrew it. */
	| {
			readonly type: "pulled";
			readonly id: number;
			readonly time: number;
			readonly reason: PullReason;
			readonly output?: string;
	  }
	| { readonly type: "sync"; readonly agent: string; readonly version: number; readonly time?: number }
	| {
			readonly type: "news";
			readonly agent: string;
			readonly pairs: readonly string[];
			readonly text: readonly string[];
			readonly time?: number;
			/** A person's announcement from the website (#41): who sent it, checked by sign-in, not an agent. */
			readonly from?: PersonSender;
	  }
	/** News handed over (all of it), or with `stale`, the news a sync made moot (all but announcements). */
	| { readonly type: "heard"; readonly agent: string; readonly stale?: boolean; readonly time?: number }
	/** An agent drops unpublished changes from its draft (restore). Nothing depends on them. */
	| {
			readonly type: "discard";
			readonly agent: string;
			readonly atoms: readonly AtomId[];
			/** When a sync wrote collision markers (#11): each block's sides, kept until the agent publishes. */
			readonly markers?: readonly MarkedRegion[];
			readonly time?: number;
	  }
	/**
	 * Drop (#10, #27): a new version of shared whose set leaves out `atoms`
	 * (the dropped versions' changes and everything in shared that built on
	 * them). History keeps them.
	 */
	| {
			readonly type: "drop";
			readonly agent: string;
			readonly version: number;
			readonly message: string;
			readonly time: number;
			/** The versions asked for, and those dropped with them as dependents. */
			readonly versions: readonly number[];
			readonly atoms: readonly AtomId[];
	  }
	/** A corrected message for a version (#27); the version's changes stay as they are. */
	| {
			readonly type: "amend";
			readonly agent: string;
			readonly space?: string;
			readonly version: number;
			readonly message: string;
			readonly time: number;
	  }
	/** A label on a version of shared (#10), or taken off it with `remove`. */
	| {
			readonly type: "label";
			readonly agent: string;
			readonly name: string;
			readonly version: number;
			readonly time: number;
			readonly remove?: boolean;
	  }
	/**
	 * A publish or land that was refused, kept for counting. Changes nothing else; refusals before this entry kind
	 * existed left no trace.
	 */
	| {
			readonly type: "refused";
			readonly agent: string;
			readonly space?: string;
			readonly via: "publish" | "land";
			readonly time: number;
			readonly collisions: readonly {
				readonly kind: Collision["kind"];
				readonly file: string;
				readonly name?: string;
			}[];
	  }
	/**
	 * What an agent says it is starting on (#37, #13), before any edit lands:
	 * shown by where and status, and named in others' overlap news. `text`
	 * null takes it back; a publish or land by the agent ends it too.
	 */
	| {
			readonly type: "starting";
			readonly agent: string;
			readonly text: string | null;
			readonly files?: readonly string[];
			readonly time: number;
			/** The issue the note works on (#54, the Issues Worker's id). */
			readonly issue?: number;
			/** A take-back because the work is finished (publish --done), which closes the note's issue (#54). */
			readonly done?: true;
	  }
	/** A named draft starts, on a version of shared. */
	| {
			readonly type: "space";
			readonly name: string;
			readonly agent: string;
			readonly time: number;
			readonly sharedBase: number;
	  }
	/**
	 * An agent moves to a space ('' for shared). What it had in the space it
	 * leaves is parked there; what it parked in the new space comes back, or
	 * it starts at `version`. With `carry`, its unpublished changes come along
	 * instead (only into a new named draft). Entries written before parking
	 * existed have no `carry` and carried.
	 */
	| {
			readonly type: "switch";
			readonly agent: string;
			readonly space: string;
			readonly version: number;
			readonly carry?: boolean;
			readonly time?: number;
	  }
	/** A named draft moves onto a newer version of shared: a new version of the draft with nothing of its own. */
	| {
			readonly type: "space-sync";
			readonly space: string;
			readonly agent: string;
			readonly time: number;
			readonly version: number;
			readonly sharedBase: number;
	  }
	/** A named draft lands in shared as one unit. */
	| {
			readonly type: "land";
			readonly space: string;
			readonly agent: string;
			readonly version: number;
			readonly message: string;
			readonly time: number;
			readonly changes: readonly AtomId[];
			readonly tie: Atom;
			/** When nothing else landed in shared since the draft's base, the draft moves onto this version. */
			readonly rebase: boolean;
			/** The change it belongs to (#44), as on a publish. */
			readonly change?: number;
	  };

/** Where entries go. The Durable Object writes them in one transaction per call. */
export interface ProjectStore {
	append(entries: readonly Entry[]): void;
}

export type ProjectErrorCode =
	| "not-initialized"
	| "already-initialized"
	| "bad-agent"
	| "bad-request"
	| "conflict"
	| "not-found"
	| "unknown-entry";

/** One side of a collision. `lines` is [first, last], 1-based; [n, n-1] means "at line n, nothing left". */
export interface CollisionSide {
	lines: [number, number];
	readonly text: string;
}

/**
 * Why a publish is refused. kind "lines": both changed the same lines (yours
 * and theirs are both in `file`). kind "definition": your new lines in `file`
 * use `name`, whose definition theirs changed (in `theirs.file`, which may be
 * another file; text "" when the definition is gone). kind "duplicate": your
 * draft and other work each define `name` at the top level of `file`, so it
 * is defined twice there; keep one.
 */
export interface Collision {
	readonly kind: "lines" | "definition" | "attribute" | "duplicate";
	/**
	 * A lines collision the agent synced into and hasn't edited since (#37):
	 * both sides' lines are in its file. Edit them, or publish with asIs.
	 */
	readonly untouched?: true;
	/** A block of collision markers in the agent's file (#11): settle it, then publish. */
	readonly marked?: true;
	readonly name?: string;
	readonly file: string;
	readonly yours: CollisionSide;
	readonly theirs: CollisionSide & {
		readonly file?: string;
		readonly agent: string;
		readonly message: string;
		readonly version: number;
		/** The named draft theirs was published in, when it isn't shared. */
		readonly draft?: string;
		/** When theirs is waiting in the merge queue, not landed (#39): its queue id. */
		readonly queued?: number;
	};
}

/** An Edit, a Write or a MultiEdit, as the hook sends it. */
export type EditBody = (
	| { readonly file: string; readonly old: string; readonly new: string }
	| { readonly file: string; readonly content: string }
	| { readonly file: string; readonly edits: readonly { readonly old: string; readonly new: string }[] }
) & { readonly session?: string; readonly subagent?: string; readonly client?: string };

/** A path written under another spelling of an existing file (#49): recorded as `existing`, one file. */
export interface Spelling {
	path: string;
	existing: string;
}
export type EditAnswer =
	| { ok: true; news: string[]; spelling?: Spelling[]; uncomposed?: string[] }
	| { ok: false; reason: "out of step" };
/** New paths not in composed form (NFC), for a gentle warning (#49). */
export type RecordAnswer = {
	ok: true;
	changed: string[];
	news: string[];
	spelling?: Spelling[];
	uncomposed?: string[];
};
export type PublishAnswer =
	| {
			ok: true;
			version: number;
			changes: number;
			mergedWith?: { version: number; agent: string; message: string }[];
			settled?: Settled[];
	  }
	/** With the merge queue on (#39): queued, not landed yet. `ahead` publishes wait in front of it. */
	| { ok: true; queued: number; position: number; ahead: number; changes: number; settled?: Settled[] }
	| { ok: false; collisions: Collision[] };
/** A publish or land that went straight into its space, or was refused. */
export type LandAnswer = Exclude<PublishAnswer, { queued: number }>;

/** A person who announced through the website, signed in (#41). */
export interface PersonSender {
	readonly person: { readonly id: string; readonly name: string };
	readonly via: "website";
}

/** One piece of work (#44): a start note's, a named draft's, or a lone publish's versions. */
export interface ChangeRecord {
	readonly id: number;
	readonly agent: string;
	readonly kind: "note" | "draft" | "publish";
	note?: { text: string; files: string[] };
	/** The issue its start note names (#54). */
	issue?: number;
	readonly draft: string | null;
	readonly time: number;
	readonly versions: { version: number; draft: string | null; message: string; time: number; at: number }[];
	readonly settled: (Settled & { version: number })[];
	readonly refusals: { at: number; time: number; kinds: string[]; files: string[] }[];
	/** The log position of its newest entry. */
	last: number;
}

/** What a note call takes (#44): lines to note, or a note to answer. */
export type NoteBody = {
	file?: unknown;
	from?: unknown;
	to?: unknown;
	text?: unknown;
	kind?: unknown;
	reply?: unknown;
	of?: unknown;
	version?: unknown;
};

/** What a note asks (#44): nothing, a fix, or nothing but "I read this". */
export type NoteKind = "comment" | "objection" | "read";

export interface NoteRecord {
	readonly id: number;
	readonly agent: string;
	readonly kind: NoteKind;
	readonly file: string;
	readonly lines: readonly LineId[];
	readonly text: string;
	readonly change?: number;
	readonly reply?: number;
	readonly time: number;
	readonly at: number;
	readonly person?: PersonSender;
	closed?: { agent: string; how: "resolved" | "withdrawn"; time: number };
}

/** A note as reads show it (#44). */
export interface NoteAnswer {
	id: number;
	/** The writer: an agent's name, or "person:<id>" for a signed-in person (then `person` says who). */
	agent: string;
	person?: { id: string; name: string };
	kind: NoteKind;
	file: string;
	/** Where its lines are now (1-based, inclusive), or null when they're all gone. */
	lines: [number, number] | null;
	text: string;
	change: number | null;
	reply: number | null;
	time: number;
	/**
	 * open; addressed (an objection whose lines are all gone: changed or taken
	 * out); outdated (a comment whose lines are all gone); resolved or
	 * withdrawn (closed by its writer).
	 */
	state: "open" | "addressed" | "outdated" | "resolved" | "withdrawn";
}

/** A change as the change page reads it (#44). */
export interface ChangeAnswer {
	id: number;
	agent: string;
	/** The start note's text, the named draft's name, or the publish's message. */
	title: string;
	kind: "note" | "draft" | "publish";
	note: { text: string; files: string[] } | null;
	/** The issue its start note names (#54), or null. */
	issue: number | null;
	draft: string | null;
	time: number;
	/** Whether its start note still lasts, so more versions may come. */
	open: boolean;
	versions: { version: number; draft: string | null; message: string; time: number; files: string[] }[];
	files: string[];
	settled: (Settled & { version: number })[];
	refusals: { time: number; kinds: string[]; files: string[] }[];
	/** Its notes, replies included, oldest first. */
	notes: NoteAnswer[];
	/** The reviewers whose areas (avcs.json's "review") its files fall in, and whether each has left a note on it. */
	reviewers: { agent: string; files: string[]; read: boolean }[];
}

/** Why a queued publish was taken out (#39). */
export type PullReason = "failed" | "depends" | "withdrawn";

/** A publish waiting in the merge queue (#39). */
export interface QueuedPublish {
	readonly id: number;
	readonly agent: string;
	readonly message: string;
	readonly time: number;
	readonly changes: readonly AtomId[];
	readonly resolves: readonly AtomId[];
	readonly settled?: readonly Settled[];
	readonly change?: number;
	/** The start note in force when it was queued (#44): its change keeps it, whatever the agent starts after. */
	readonly note?: Starting;
}

/** A marked collision the publish settled (#11): what the agent kept, against whose version. */
export interface Settled {
	file: string;
	kept: Kept;
	theirs: { agent: string; version: number };
	/** Lines both sides still had that the settled file lost (#37, Playtester 1): check them. */
	lost?: string[];
}
/** A line both sides changed that a sync merged word by word (#37): check it. */
export interface MergedLine {
	file: string;
	/** 1-based, in the agent's file after the sync. */
	line: number;
	text: string;
	theirs?: { agent: string; message: string; version: number };
}
/** `modes` lists files whose executable bit or link target changed, when there are any. */
export type SyncAnswer = {
	version: number;
	files: Files;
	collisions: Collision[];
	modes?: Modes;
	merged?: MergedLine[];
};
export type SwitchAnswer = SyncAnswer & { draft: string | null };
export type DraftSyncAnswer = { draft: string; version: number; sharedBase: number };
/** A plain-git push taken in: landed in shared, or waiting in its named draft with its collisions. */
export type IngestAnswer =
	| { landed: true; version: number; draft: string; changes: number }
	| { landed: false; version: number; draft: string; collisions: Collision[] };
export interface AgentStatus {
	agent: string;
	/** The named draft it works in, or null for shared. */
	draft: string | null;
	/** Its base: a version of its space. */
	base: number;
	draftChanges: number;
	files: string[];
	/** Unpublished work it left parked in other spaces, which comes back when it switches there. */
	parked: { draft: string | null; draftChanges: number }[];
	/** What it said it is starting on (#37), if it said. */
	starting?: Starting;
	/** Its publishes waiting in the merge queue (#39), when there are any. */
	queued?: number[];
	/** How its newest edit arrived (#41, the edits mark): through the mod, the hook, or commands (abso record, a git push); none yet. */
	edits: EditsVia;
	/** With `edits` "mod": whether its mod is the newest any agent here has edited with. Otherwise null. */
	modCurrent: boolean | null;
	/** Its newest edit's time, or null. */
	lastEdit: number | null;
	/** Its join entry's log position: agents in join order. */
	joined: number | null;
	/** Blocks of collision markers still in its files (#11), when there are any. */
	collisions?: { file: string; lines: [number, number]; theirs: { agent: string; version: number; message: string } }[];
}
export interface DraftStatus {
	name: string;
	version: number;
	/** The shared version it builds on. */
	sharedBase: number;
	/** Changes published into it that haven't landed in shared. */
	changes: number;
	agents: string[];
}
/**
 * One tell as the log has it: the sentence its recipients get, when it was sent, and for each recipient when its
 * client handed it over (a heard entry), null until then. A time is undefined for entries from before they had one.
 */
export interface TellRecord {
	readonly id: number;
	text: string;
	at: number | undefined;
	readonly heard: Map<string, { at: number | undefined } | null>;
}
export interface TellStatus {
	id: number;
	text: string;
	at: number | null;
	to: { agent: string; heard: boolean; at: number | null }[];
}
export type StatusAnswer = {
	version: number;
	agents: AgentStatus[];
	drafts: DraftStatus[];
	refusals: RefusalCounts;
	/** Announcements some agent hasn't received yet, oldest first. */
	announcements: { text: string; waiting: string[] }[];
	/** The newest tells (TELLS_KEPT), newest first: each recipient, and when it heard (null: not yet). */
	tells: TellStatus[];
	/** Only when shared has both abso.json and avcs.json (224): abso.json counts and avcs.json is ignored. */
	projectFile?: { used: "abso.json"; ignored: "avcs.json" };
};

/** Refused publishes and lands, counted by collision kind (a refusal can have several kinds). */
export interface RefusalCounts {
	total: number;
	lines: number;
	definition: number;
	attribute: number;
	duplicate: number;
}

/** One refused publish or land. */
export interface Refusal {
	agent: string;
	draft: string | null;
	via: "publish" | "land";
	time: number;
	collisions: { kind: Collision["kind"]; file: string; name?: string }[];
}
/** One file before and after: text, or null where it doesn't exist. */
export interface FileChange {
	path: string;
	before: string | null;
	after: string | null;
	/** When the executable bit or link target changed too. */
	mode?: { before: Mode; after: Mode };
	/** When the file is or was binary and its bytes changed: each side's SHA-256, or null for text or no file. */
	blob?: { before: string | null; after: string | null };
}

/** Binary files: path -> the SHA-256 of its bytes (lowercase hex). In answers, null: no longer binary. */
export type Blobs = Record<string, string | null>;

/** What the project needs from the store of binary files' bytes. */
export interface ProjectOptions {
	/** Whether the bytes for a SHA-256 have been uploaded. Without it, no blob is held, so binary files are refused. */
	hasBlob?: (sha256: string) => boolean;
	/** The time now, for start notes that end after 2 hours idle (#44). Without it, the newest entry's time. */
	now?: () => number;
	/**
	 * Where whole files' text goes (#46): `keep` stores text as a blob and
	 * answers its SHA-256; `read` gives it back. Without it, no file is kept
	 * whole and every text file is tracked by line.
	 */
	whole?: { keep(text: string): string; read(sha: string): string | null };
	/**
	 * Where each version's changed files are kept between loads (#41): a
	 * published version never changes, so they are worked out once per
	 * project, not once per load. Rows are keyed by space and version and say
	 * which version they describe, so a row that doesn't match is ignored.
	 * Without it, they're worked out again after each load.
	 */
	shapes?: {
		get(space: string, version: number): string | undefined;
		put(space: string, version: number, value: string): void;
	};
	/**
	 * The stored entry at a log position (#46, text on disk). With it, the
	 * project keeps no line text in memory: it reads a change's text back from
	 * the entry that recorded it when a file is laid out, keeping the most
	 * recent. Without it, all text stays in memory.
	 */
	entryAt?: (at: number) => Entry;
}
export interface LogEntry {
	version: number;
	/** The change it belongs to (#44): the id change/<id> reads. */
	change?: number;
	agent: string;
	message: string;
	time: number;
	/** Changes it brought in (its tie left out). */
	changes: number;
	files: string[];
	/** For a drop: the versions it took out. */
	drops?: number[];
	/** When a later drop took this version's changes out of shared. */
	droppedIn?: number;
	/** Labels on this version (shared only). */
	labels?: string[];
	/** The message it was published with, when an amend corrected it. */
	originalMessage?: string;
	/** In a file's history across moves (#41, F27): the file's name at this version, when it isn't the name asked for. */
	path?: string;
}
export type LogAnswer = {
	draft: string | null;
	version: number;
	versions: LogEntry[];
	/** With more below: the `before` for the next page (#41). */
	next?: number;
	/** With a path: its stored spelling (#41, F7), and the names it had before moves, newest first (F27). */
	path?: string;
	movedFrom?: { path: string; version: number }[];
};

/** Who changed a path last, and when (#41, the Files pages). */
export interface LastChange {
	version: number;
	agent: string;
	time: number;
	message: string;
}

/** A version's net effect on paths beyond `files` (#41): files it made, files it took out, and moves between them. */
export interface VersionShape {
	made: string[];
	gone: string[];
	moves: [string, string][];
}

/** One path's history in a space (#41): the versions that changed it, and when it was made and taken out. */
export interface PathLife {
	changed: number[];
	events: { version: number; made: boolean; other?: string }[];
}

/** Two agents' unpublished changes that would collide by the publish rule (#41, F22). */
export interface DraftCollision {
	kind: "lines" | "definition" | "attribute" | "duplicate";
	name?: string;
	file: string;
	/** If `first` publishes first, `second`'s publish is refused for this (for lines, either way). */
	first: { agent: string; file: string; lines: [number, number]; text: string };
	second: { agent: string; file: string; lines: [number, number]; text: string };
}
export type ShowAnswer = LogEntry & { draft: string | null; diff: FileChange[] };
export type DiffAnswer = { draft: string | null; base: number; files: FileChange[] };
export type RestoreAnswer = { files: Files; dropped: number; modes?: Modes };
export type PluckAnswer =
	| { ok: true; version: number; changes: number; plucked: { version: number; agent: string; message: string }[] }
	| {
			ok: false;
			/** Other versions of the draft the asked-for ones build on: pass withDependencies to take them too. */
			needs: { version: number; agent: string; message: string }[];
			/** Collisions with shared, as for a land. */
			collisions: Collision[];
	  };
export type DropAnswer =
	| { ok: true; version: number; dropped: { version: number; agent: string; message: string }[] }
	| {
			ok: false;
			/** Later versions that build on the ones asked for: pass withDependents to drop them too. */
			dependents: { version: number; agent: string; message: string }[];
			/** Unpublished work that builds on them: agents' drafts and named drafts. */
			blocked: { agent?: string; draft?: string; files: string[] }[];
	  };

/** Who sent a recording: the chat's session and subagent, and the client (#41). */
export type Meta = { session?: string; subagent?: string; client?: string };

/** How an agent's newest edit arrived (#41, the edits mark). */
export type EditsVia = "mod" | "hook" | "commands" | "none";

export interface AgentState {
	readonly name: string;
	/** Its join entry's log position (#41): the website colors agents in join order. */
	joined?: number;
	/** Its start note's log position, while the note lasts: the change it names (#44). */
	noteAt?: number;
	/** When it last recorded, published or wrote a start note: a note ends after 2 hours without any (#44). */
	lastActive?: number;
	/** Its newest recording's time and sender (#41). */
	lastEdit?: { time: number; session?: string; client?: string };
	/** The space it works in: '' for shared, or a named draft. */
	space: string;
	/** The version of its space it last synced to. */
	base: number;
	/** Whether it has synced at least once (its folder holds its space at its base). */
	synced: boolean;
	/** Changes it made since its base, published or not. Its view is its space at its base plus these. */
	mine: AtomId[];
	news: string[];
	/** When each of `news` was made, in step with it; undefined for news logged before entries had times (#41). */
	newsAt: (number | undefined)[];
	/** Collision pairs ("yours theirs") it has already been told about. */
	told: Set<string>;
	/** Where it left each other space it worked in: its base there and its changes since. */
	parked: Map<string, { base: number; mine: AtomId[] }>;
	/** What it said it is starting on, until it publishes, lands or takes it back. */
	starting?: Starting;
	/** Collisions a sync wrote markers for (#11), until it publishes in that space. */
	marked: (MarkedRegion & { space: string })[];
}

/** Another agent with work on a file: unpublished changes, a starting note, or both. */
export interface Overlap {
	agent: string;
	file: string;
	/** Its unpublished changes that touch the file. */
	changes?: number;
	/** Its starting note's text. */
	starting?: string;
}

/** An agent's note on what it is starting on (#37, #13). */
export interface Starting {
	text: string;
	files: string[];
	time: number;
	/** The issue it works on (#54). */
	issue?: number;
}

/** What the Issues Worker is told when a start note naming an issue begins or ends (#54). */
export interface IssueHook {
	readonly issue: number;
	readonly agent: string;
	/** The change: the start note's log position. */
	readonly change: number;
	/** For an end: whether the work is finished (publish --done), which closes the issue. */
	readonly done?: boolean;
	/** For an end: the change's newest version of shared, if it has one. */
	readonly version?: number;
}

/** A tuple without its first element. */
export type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
