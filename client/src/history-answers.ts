// What the server answers about history: files, log, show, diff, blame, why, where, drop and pluck.

import type { Collision } from "./api-answers.ts";
import type { CiMark } from "./ci-answers.ts";
import type { Mode, Modes } from "./modes.ts";

/** The space a history call reads: a named draft (null: shared), or the one an agent is in. */
export type Where = { readonly draft: string | null } | { readonly agent: string };

/** The paths in a view (#37): the agent's, or a space's at a version. */
export interface FilesAnswer {
	readonly version: number;
	readonly draft: string | null;
	readonly files: readonly string[];
}

/** One file's change: its text before and after, null where the file doesn't exist. */
export interface FileChange {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
	/** When the executable bit or the link target changed too. */
	readonly mode?: { readonly before: Mode; readonly after: Mode };
	/** A binary file's bytes, by sha256 (null where it wasn't binary, or didn't exist). */
	readonly blob?: { readonly before: string | null; readonly after: string | null };
	/** Set by the client (diff.ts pairRenames) when this file is another one renamed: its old path, and how much of it is the same (0-100). */
	readonly from?: string;
	readonly similarity?: number;
}
/**
 * Who to name for a version: its original author when the project's history
 * was imported (abso issue 23, like git's author beside its committer), else
 * the agent who published it. Code that matches agents keeps using agent.
 */
export function byWhom(p: { readonly agent: string; readonly author?: string }): string {
	return p.author ?? p.agent;
}

export interface LogEntry {
	readonly version: number;
	readonly agent: string;
	/** Who first wrote it, when the project's history was imported (abso issue 23); agent is who published it here. */
	readonly author?: string;
	readonly message: string;
	readonly time: number;
	readonly changes: number;
	readonly files: readonly string[];
	/** The versions this one dropped, and the version that dropped this one. */
	readonly drops?: readonly number[];
	readonly droppedIn?: number;
	readonly labels?: readonly string[];
	/** The message as first published, when it was amended. */
	readonly originalMessage?: string;
	/** Shared versions only: what CI made of it (#39). */
	readonly ci?: CiMark;
	/** The change it belongs to (#44): the log position that began it. */
	readonly change?: number;
}
/** A published version as drop and pluck name it. */
export interface VersionRef {
	readonly version: number;
	readonly agent: string;
	readonly message: string;
}
export type DropAnswer =
	| { readonly ok: true; readonly version: number; readonly dropped: readonly VersionRef[] }
	| {
			readonly ok: false;
			readonly dependents?: readonly VersionRef[];
			readonly blocked?: readonly {
				readonly agent?: string;
				readonly draft?: string;
				readonly files: readonly string[];
			}[];
	  };
export type PluckAnswer =
	| { readonly ok: true; readonly version: number; readonly changes: number; readonly plucked: readonly unknown[] }
	| { readonly ok: false; readonly needs?: readonly VersionRef[]; readonly collisions?: readonly Collision[] };
/** Which view to read: a named draft, or an agent's own (its unpublished lines marked). */
export type View = { readonly draft?: string; readonly agent?: string };
export interface LogAnswer {
	readonly draft: string | null;
	readonly version: number;
	readonly versions: readonly LogEntry[];
	/** When older versions are left: the version to read below (log --before) for the next ones. */
	readonly next?: number;
}
export interface ShowAnswer extends LogEntry {
	readonly draft: string | null;
	readonly diff: readonly FileChange[];
}
export interface DiffAnswer {
	readonly draft: string | null;
	readonly base: number | null;
	readonly files: readonly FileChange[];
}
export interface RestoreAnswer {
	readonly files: Readonly<Record<string, string | null>>;
	readonly dropped: number;
	readonly modes?: Modes;
	readonly blobs?: Readonly<Record<string, string | null>>;
}

/** The publish that brought a change into shared. */
export interface Publish {
	readonly version: number;
	readonly agent: string;
	/** Who first wrote it, when the project's history was imported (abso issue 23). */
	readonly author?: string;
	readonly message: string;
	readonly time: number;
}
export interface BlameAnswer {
	readonly file: string;
	/** null for an agent's view, which is its current one. */
	readonly version: number | null;
	readonly draft?: string;
	readonly agent?: string;
	readonly total: number;
	readonly from: number;
	readonly to: number;
	readonly lines: readonly {
		readonly n: number;
		readonly text: string;
		readonly atom: string;
		readonly author: string;
		readonly version: number | null;
		readonly unpublished?: boolean;
	}[];
	readonly atoms: readonly {
		readonly atom: string;
		readonly author: string;
		readonly message: string;
		readonly time: number;
		readonly publish: Publish | null;
	}[];
}
export interface WhyAnswer {
	readonly file: string;
	readonly line: number;
	readonly text: string;
	readonly change: { readonly atom: string; readonly author: string; readonly message: string; readonly time: number };
	readonly publish: Publish | null;
	readonly reasons: readonly {
		readonly kind: string;
		readonly text: string;
		readonly to: string;
		readonly toAuthor: string;
		readonly toMessage: string;
	}[];
	readonly reasonsIn: readonly {
		readonly kind: string;
		readonly text: string;
		readonly from: string;
		readonly fromAuthor: string;
		readonly fromMessage: string;
	}[];
	readonly settled: readonly {
		readonly atom: string;
		readonly author: string;
		readonly message: string;
		readonly publish: Publish | null;
	}[];
	/** When the line's own change settled nothing: the settle that kept it from a marker block. */
	readonly settledBy?: { readonly atom: string; readonly author: string; readonly publish: Publish | null };
	/** The settler's push that was held for the collision, with its message: that side's reason. */
	readonly held?: { readonly agent: string; readonly message: string; readonly time: number };
}
export interface WhereAnswer {
	readonly version: number;
	readonly files: Readonly<
		Record<
			string,
			readonly {
				readonly agent: string;
				readonly lines: readonly [number, number][];
				readonly shared: readonly [number, number][];
				readonly changes: number;
				readonly lastEdit: number;
			}[]
		>
	>;
	/** What agents said they are starting on (#37); absent from an older server. */
	readonly starting?: readonly StartingNote[];
}

/** An agent's note on what it is starting on (#37, #13). */
export interface StartingNote {
	readonly agent: string;
	readonly draft: string | null;
	readonly text: string;
	readonly files: readonly string[];
	readonly time: number;
}

/** Another agent already working on a file a starting note names. */
export interface Overlap {
	readonly agent: string;
	readonly file: string;
	readonly changes?: number;
	readonly starting?: string;
}
