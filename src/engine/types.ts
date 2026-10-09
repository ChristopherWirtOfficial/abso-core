// Core data shapes of the engine. Everything here is plain data so a graph can
// be saved as JSON and loaded anywhere (Node, a browser, a Worker).

/** "a<seq>". a0 is the imported starting snapshot; each accepted atom is the next seq. */
export type AtomId = string;

/** "<atomId>.<k>": the k-th line that atom inserted (k counts across all of its runs). */
export type LineId = string;

/** A line id, or "^<path>" for the start node of a file. */
export type NodeId = string;

/**
 * A claim key. "L:<lineId>" names a line; "G:<nodeId>" names the gap right
 * after a line (or right after the start of a file, "G:^<path>");
 * "A:<attr>:<path>" names one attribute of a file; "P:<lineId>" names where a
 * line sits (its parent), which a move changes.
 */
export type Key = string;

/**
 * A file's attributes, beyond its lines:
 * - exists: "1" keeps the file even with no lines (an empty file);
 * - exec: "1" for an executable file;
 * - link: the target, for a symbolic link;
 * - blob: the SHA-256 (lowercase hex) of a binary file's bytes, which are
 *   kept outside the graph. A binary file has no lines.
 * null clears it.
 */
export type AttrName = "exists" | "exec" | "link" | "blob";
export const ATTR_NAMES: readonly AttrName[] = ["exists", "exec", "link", "blob"];

/** One attribute an atom sets. The newest setter (by priority) in a set wins. */
export interface AttrSet {
	readonly file: string;
	readonly name: AttrName;
	readonly value: string | null;
}

/**
 * One line a move relocates: in a set, a line hangs off the parent its newest
 * relocation (by priority) gives it, or else the one it was written after. A
 * line belongs to whichever file its chain of parents reaches.
 */
export interface Relocation {
	readonly line: LineId;
	/** A line, or the start node of a file. */
	readonly parent: NodeId;
}

/** A set of atoms. A codebase state is a closed set (every atom's deps are in it). */
export type AtomSet = ReadonlySet<AtomId>;

/**
 * How a pure insertion claims its neighbours.
 * - both: reads the line above and the line below (the default).
 * - after: reads only the line above ("I just need to come after X").
 * - before: reads only the line below ("I just need to come before Y", such
 *   as an item appended above a closing bracket).
 * - wide: like both, and also holds every line of the edited span and the gaps
 *   between them, so nobody can change or insert inside it independently.
 * At the edge of a file, after and before read the one neighbour there is.
 */
export type Mode = "both" | "after" | "before" | "wide";
export const MODES: readonly Mode[] = ["both", "after", "before", "wide"];

export type ReasonKind = "together" | "because-of" | "supersedes";
export const REASON_KINDS: readonly ReasonKind[] = ["together", "because-of", "supersedes"];

/** A link from one atom to another, with free text saying why. Not a dependency. */
export interface Reason {
	readonly to: AtomId;
	readonly kind: ReasonKind;
	readonly text: string;
}

/**
 * A run of consecutive new lines in one file. Line 0's parent is `parent`;
 * line i's parent is line i-1 of the same run.
 */
export interface InsertRun {
	readonly file: string;
	readonly parent: NodeId;
	readonly lines: readonly string[];
}

/**
 * One small change. Atoms never change once accepted. Line ids of the inserted
 * lines are derived: `<id>.<k>`, k counting from 0 across `inserts` in order.
 */
export interface Atom {
	readonly id: AtomId;
	readonly seq: number;
	readonly author: string;
	/** The why. */
	readonly message: string;
	/** Milliseconds since the epoch, supplied by the caller (the engine never reads a clock). */
	readonly time: number;
	readonly inserts: readonly InsertRun[];
	readonly deletes: readonly LineId[];
	/** Keys this atom changes: deleted lines (L:) and gaps it inserts into (G:). */
	readonly writes: readonly Key[];
	/** Implicit reads: the neighbours of its pure insertions. */
	readonly reads: readonly Key[];
	/** Explicit claims (holds): reliesOn ranges, wide spans, claim spans. */
	readonly holds: readonly Key[];
	readonly needs: readonly AtomId[];
	readonly resolves: readonly AtomId[];
	readonly reasons: readonly Reason[];
	/** Derived when the atom was built against its view; sorted by seq. */
	readonly deps: readonly AtomId[];
	/** File attributes it sets (absent on atoms that set none). Each writes its A: key. */
	readonly attrs?: readonly AttrSet[];
	/**
	 * Lines it relocates (absent on atoms that move nothing). Each writes the
	 * line's P: key and the G: key of its new parent.
	 */
	readonly moves?: readonly Relocation[];
}

/**
 * What git calls a commit: a head atom plus everything it needed, minus a base.
 * `base` is a label name or an atom id. Title, message and follows are notes.
 */
export interface Label {
	readonly name: string;
	readonly head: AtomId;
	readonly base?: string;
	readonly title: string;
	readonly message: string;
	/** Names of labels this one follows. A note, not structure. */
	readonly follows?: readonly string[];
}

export type ErrorCode =
	| "unknown-atom"
	| "unknown-line"
	| "unknown-ref"
	| "bad-atom"
	| "bad-label"
	| "bad-json"
	| "bad-edit"
	| "bad-range"
	| "no-match"
	| "ambiguous-match"
	| "overlapping-edits"
	| "not-in-view"
	| "not-closed"
	| "not-in-set"
	| "empty-atom";

/** Every error the engine throws on bad input. `code` is stable; `message` is for people. */
export class EngineError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "EngineError";
		this.code = code;
	}
}
