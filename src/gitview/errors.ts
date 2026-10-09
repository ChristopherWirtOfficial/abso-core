// Errors the git view and ingest throw on bad input. Engine errors (an unknown
// atom or ref, for example) pass through unchanged as EngineError.

export type GitViewErrorCode =
	/** The set to view has no atoms. */
	| "empty-set"
	/** An explicit set to view is missing some atom's dependencies. */
	| "not-closed"
	/** writeView was pointed at a directory that already has files in it. */
	| "dir-not-empty"
	/** A projected path can't be a git path (empty part, "..", ".git", or a file that is also a directory). */
	| "bad-path"
	/** The repo can't be read (no HEAD, or the ref doesn't resolve). */
	| "bad-repo"
	/** No commit on HEAD's first-parent chain is a view of this graph or an ingested commit. */
	| "no-view-base";

export class GitViewError extends Error {
	readonly code: GitViewErrorCode;
	constructor(code: GitViewErrorCode, message: string) {
		super(message);
		this.name = "GitViewError";
		this.code = code;
	}
}
