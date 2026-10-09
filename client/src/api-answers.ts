// What the server answers for recording, publishing, syncing, notes and status.

import type { CiStatus, QueueState } from "./ci-answers.ts";
import type { Modes } from "./modes.ts";

/** A collision as publish and sync report it. */
export interface Collision {
	/**
	 * `lines`: both changed the same lines. `definition`: your draft uses `name`, whose definition they changed.
	 * `attribute`: both set `name` (exec or link). `duplicate`: you and they each define `name` at the top level of `file`.
	 */
	readonly kind?: "lines" | "definition" | "attribute" | "duplicate";
	/** A lines collision you synced into and haven't edited since (#37): both sides' lines are in your file. */
	readonly untouched?: true;
	/** A lines collision written into the file as a marker block (#11): `lines` is the block's range there. */
	readonly marked?: true;
	readonly lines?: readonly [number, number];
	readonly name?: string;
	readonly file: string;
	readonly yours: { readonly lines: unknown; readonly text: string };
	/** For a definition, `file` is where the definition is, and `text` is "" when it's gone. */
	readonly theirs: {
		readonly file?: string;
		readonly agent: string;
		readonly message: string;
		readonly version: number;
		readonly lines: unknown;
		readonly text: string;
		/** Theirs is waiting in the merge queue, not landed yet (#39): its queue id. */
		readonly queued?: number;
	};
}

/** News arrives as one plain sentence per collision; accept a single string too. */
export type News = string | readonly string[] | undefined;

export interface EditBody {
	readonly file: string;
	readonly old?: string;
	readonly new?: string;
	readonly content?: string;
	readonly edits?: readonly { readonly old: string; readonly new: string }[];
	readonly session?: string;
	readonly subagent?: string;
}

/** A path recorded under another spelling of an existing file (#49): one file whatever its case. */
export interface Spelling {
	readonly path: string;
	readonly existing: string;
}
export type EditAnswer =
	| { ok: true; news?: News; spelling?: readonly Spelling[]; uncomposed?: readonly string[] }
	| { ok: false; reason: string };
/** A marker block still in an agent's draft (#11). */
export interface OpenCollision {
	readonly file: string;
	readonly lines: readonly [number, number];
	readonly theirs: { readonly agent: string; readonly version: number; readonly message: string };
}
/** What a publish settled, file by file, and which side survived (#11). */
export interface Settled {
	readonly file: string;
	readonly kept: "yours" | "theirs" | "both" | "rewrote";
	readonly theirs: { readonly agent: string; readonly version: number };
	/** Lines both sides still had that the settled file no longer has (#37, Playtester 1). */
	readonly lost?: readonly string[];
}
export interface RecordAnswer {
	readonly ok: boolean;
	readonly changed?: readonly string[] | number;
	readonly news?: News;
	readonly reason?: string;
	readonly spelling?: readonly Spelling[];
	/** New names not in composed Unicode form (#49): a gentle warning. */
	readonly uncomposed?: readonly string[];
}
export type PublishAnswer =
	| {
			ok: true;
			version: number;
			changes?: number;
			settled?: readonly Settled[];
			/** Others' versions this publish went on top of that the folder hasn't synced yet (#37): nothing of theirs was overwritten. */
			mergedWith?: readonly { readonly version: number; readonly agent: string; readonly message: string }[];
	  }
	/** With the merge queue on (#39): queued, not landed yet; `ahead` publishes wait in front of it. */
	| { ok: true; queued: number; position: number; ahead: number; changes: number; settled?: readonly Settled[] }
	| { ok: false; collisions: readonly Collision[]; reason?: string };
/** A note on lines (#44): where its lines are now, or null when they're all gone. */
export interface NoteAnswer {
	readonly id: number;
	readonly agent: string;
	readonly kind: "comment" | "objection" | "read";
	readonly file: string;
	readonly lines: readonly [number, number] | null;
	readonly text: string;
	readonly change: number | null;
	readonly reply: number | null;
	readonly time: number;
	readonly state: "open" | "addressed" | "outdated" | "resolved" | "withdrawn";
}
/** One change (#44): a start note's work, a named draft's, or a lone publish. Its id is the log position that began it. */
export interface ChangeAnswer {
	readonly id: number;
	readonly agent: string;
	readonly title: string;
	readonly kind: "note" | "draft" | "publish";
	readonly note: { readonly text: string; readonly files: readonly string[] } | null;
	readonly draft: string | null;
	readonly time: number;
	/** Its start note still lasts, or its draft hasn't landed: more versions may come. */
	readonly open: boolean;
	readonly versions: readonly {
		readonly version: number;
		readonly draft: string | null;
		readonly message: string;
		readonly time: number;
		readonly files: readonly string[];
	}[];
	readonly files: readonly string[];
	readonly settled: readonly (Settled & { readonly version: number })[];
	readonly refusals: readonly {
		readonly time: number;
		readonly kinds: readonly string[];
		readonly files: readonly string[];
	}[];
	readonly notes?: readonly NoteAnswer[];
	readonly reviewers?: readonly { readonly agent: string; readonly files: readonly string[]; readonly read: boolean }[];
}
/** The body of a note: on lines, or a reply to one. */
export type NoteBody =
	| {
			readonly file: string;
			readonly from: number;
			readonly to: number;
			readonly text: string;
			readonly kind?: "comment" | "objection" | "read";
			readonly of?: string;
			readonly version?: number;
	  }
	| { readonly reply: number; readonly text: string };

export interface SyncAnswer {
	readonly version: number;
	readonly files: Readonly<Record<string, string | null>>;
	/** Files whose executable bit or link changed: {exec, link}. */
	readonly modes?: Modes;
	/** Binary files whose bytes changed: path -> sha256, or null when the file is no longer binary. */
	readonly blobs?: Readonly<Record<string, string | null>>;
	readonly collisions?: readonly Collision[];
	/** Lines both sides changed that sync merged item by item (a one-line list both added to): not collisions, but worth a look (#37). */
	readonly merged?: readonly MergedLine[];
}
export interface MergedLine {
	readonly file: string;
	readonly line: number;
	readonly text: string;
	readonly theirs: { readonly agent: string; readonly message: string; readonly version: number };
}
export interface StatusAnswer {
	readonly version: number;
	readonly agents: readonly {
		readonly agent: string;
		/** The named draft it works in, or null (or absent) for shared. */
		readonly draft?: string | null;
		readonly base: number | null;
		readonly draftChanges: number;
		readonly files: readonly string[] | number;
		/** Unpublished work it left parked in other spaces. */
		readonly parked?: readonly { readonly draft: string | null; readonly draftChanges: number }[];
		/** Marker blocks still in its draft (#11): collisions to settle. */
		readonly collisions?: readonly OpenCollision[];
		/** It reads and records nothing (#37). */
		readonly reader?: true;
		/** Its publishes waiting in the merge queue (#39). */
		readonly queued?: readonly number[];
	}[];
	readonly drafts?: readonly {
		readonly name: string;
		readonly version: number;
		readonly sharedBase: number;
		readonly changes: number;
		readonly agents: readonly string[];
	}[];
	/** The project's CI (#39); absent from servers without it. */
	readonly ci?: CiStatus;
	/** The merge queue (#39), while anything waits or it's paused. */
	readonly queue?: QueueState | null;
	/** Only when shared has both project files: abso.json counts, avcs.json is ignored. */
	readonly projectFile?: { readonly used: string; readonly ignored: string };
}
/** `POST /a/:agent/draft` answers like a sync, naming the space the agent is now in. */
export interface SwitchAnswer extends SyncAnswer {
	readonly draft: string | null;
}
export interface DraftSyncAnswer {
	readonly draft: string;
	readonly version: number;
	readonly sharedBase: number;
}
