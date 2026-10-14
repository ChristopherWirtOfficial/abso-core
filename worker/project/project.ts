// The project a Durable Object holds: shared (the published set), named
// drafts, each agent's draft, publish, sync and news. Pure TypeScript with no
// Node or Workers imports; the object passes the time in and stores what
// `append` hands it. The contract is docs/v2-slice1.md.
//
// Every change goes through an entry. A call works out its entries, applies
// them, and hands them to the store in one `append`. Loading applies the same
// entries again, so a reloaded project is the same project.
//
// A space is somewhere agents publish to. Shared is one. A named draft (#10)
// is another: a small shared that builds on a version of shared, that its
// agents publish into under the same rules, and that lands in shared as one
// unit. Every agent works in one space at a time.

import { type Atom, type AtomId, EngineError, Graph, type LineId, type ReadView } from "../../src/engine/index.ts";
import {
	CachedStateStorage,
	differenceSet,
	type GraphStateStorage,
	StableOverlaySet,
	StableSet,
	StableUnionSet,
	StoredMap,
	storedArray,
	unionOverlay,
} from "../../src/engine/state-source.ts";
import { type AddDraftHost, addDraft as hostedAddDraft } from "./add-draft.ts";
import { type AmendHost, amend as hostedAmend } from "./amend.ts";
import { type AnnounceHost, announce as hostedAnnounce, announcePerson as hostedAnnouncePerson } from "./announce.ts";
import { type ApplyEntryHost, applyEntry as hostedApplyEntry } from "./apply-entry.ts";
import {
	type ChangeHost,
	change as hostedChange,
	changeRecord as hostedChangeRecord,
	changes as hostedChanges,
	joinChange as hostedJoinChange,
	namedFiles as hostedNamedFiles,
} from "./change-records.ts";
import { type ChangesSinceHost, changesSince as hostedChangesSince } from "./changes-since.ts";
import { type CheckClashHost, checkClash as hostedCheckClash } from "./check-clash.ts";
import {
	type CollisionHost,
	describePair,
	duplicateCollisions,
	openPairs as hostedOpenPairs,
	type Origin,
	originOf,
	type Pair,
	pairsIn,
	strandedFiles,
	touchedFiles,
} from "./collisions.ts";
import { type DefinitionCollision, DefinitionRule } from "./definition-rule.ts";
import { type DraftCollisionHost, draftCollisions } from "./draft-collisions.ts";
import { type DraftDiffHost, diffOfAgent, diffOf as draftDiffOf } from "./draft-diff.ts";
import { type DraftStateHost, draftState as hostedDraftState } from "./draft-state.ts";
import { type DropHost, drop as hostedDrop } from "./drop.ts";
import { type EditHost, edit as hostedEdit } from "./edit.ts";
import { type ExpressMovesHost, expressMoves as hostedExpressMoves } from "./express-moves.ts";
import {
	type HistoryHost,
	follow as historyFollow,
	pathLife as historyPathLife,
	tree as historyTree,
} from "./history.ts";
import { ingest as hostedIngest, type IngestHost } from "./ingest.ts";
import { init as hostedInit, type InitHost } from "./init.ts";
import { label as hostedLabel, type LabelHost } from "./label.ts";
import {
	land as hostedLand,
	landCollisions as hostedLandCollisions,
	landDraft as hostedLandDraft,
	type LandHost,
} from "./land.ts";
import {
	blocksIn,
	markedCollisions as hostedMarkedCollisions,
	markedFiles as hostedMarkedFiles,
	markerCollisions as hostedMarkerCollisions,
	markersSettled as hostedMarkersSettled,
	openCollisions as hostedOpenCollisions,
	type MarkerHost,
} from "./markers.ts";
import { MemoryStore } from "./memory-store.ts";
import { mergeIdentical as hostedMergeIdentical, type MergeHost } from "./merge-identical.ts";
import { move as hostedMove, type MoveHost } from "./move.ts";
import {
	addressedItem,
	newsAboutOwnDraft as hostedNewsAboutOwnDraft,
	newsForOthers as hostedNewsForOthers,
	markedItem,
	type NewsHost,
	type NewsItem,
	reviewItem,
	settledItem,
} from "./news.ts";
import {
	closeNote as hostedCloseNote,
	noteAnswer as hostedNoteAnswer,
	notes as hostedNotes,
	startingNotes as hostedStartingNotes,
	writeNote as hostedWriteNote,
	type NoteHost,
	type NoteWriteHost,
	type ReviewRule,
	reviewersOf,
	reviewRulesIn,
} from "./notes.ts";
import {
	draftFiles as hostedDraftFiles,
	overlapNews as hostedOverlapNews,
	overlaps as hostedOverlaps,
	type OverlapHost,
} from "./overlaps.ts";
import { checkPath } from "./path-rules.ts";
import { PathIndex } from "./pathindex.ts";
import { pathKey } from "./pathkey.ts";
import { pluck as hostedPluck, type PluckHost } from "./pluck.ts";
import { ProjectError } from "./project-error.ts";
import { checkDraftName, checkPerson, NAME, projectFileIn } from "./project-helpers.ts";
import {
	type SnapshotHost,
	agentPaths as snapshotAgentPaths,
	labels as snapshotLabels,
	pathsAt as snapshotPathsAt,
	pathsOf as snapshotPathsOf,
	status as snapshotStatus,
} from "./project-status.ts";
import type {
	AgentState,
	AgentStatus,
	ChangeAnswer,
	ChangeRecord,
	Collision,
	DiffAnswer,
	DraftSyncAnswer,
	DropAnswer,
	EditsVia,
	Entry,
	LandAnswer,
	MergedLine,
	Modes,
	NoteAnswer,
	NoteBody,
	NoteRecord,
	PersonSender,
	PluckAnswer,
	ProjectOptions,
	ProjectStore,
	PublishAnswer,
	QueuedPublish,
	Refusal,
	Settled,
	Starting,
	Tail,
	TellRecord,
} from "./project-types.ts";
import { publish as hostedPublish, publishDraft as hostedPublishDraft, type PublishHost } from "./publish.ts";
import { publishOf as hostedPublishOf, type PublishOfHost } from "./publish-of.ts";
import {
	enqueue as hostedEnqueue,
	notQueuedYet as hostedNotQueuedYet,
	queue as hostedQueue,
	queueCandidate as hostedQueueCandidate,
	queueChecking as hostedQueueChecking,
	queuedAtoms as hostedQueuedAtoms,
	queueLand as hostedQueueLand,
	queueOn as hostedQueueOn,
	queuePull as hostedQueuePull,
	unqueue as hostedUnqueue,
	type QueueHost,
} from "./queue.ts";
import { record as hostedRecord, type RecordHost } from "./record.ts";
import { recordFile as hostedRecordFile, type RecordFileHost } from "./record-file.ts";
import { refusals as hostedRefusals, refuse as hostedRefuse, type RefuseHost } from "./refuse.ts";
import { restore as hostedRestore, type RestoreHost } from "./restore.ts";
import { last, Membership, SHARED, SharedAdditions, type Space, sharedBaseOf } from "./spaces.ts";
import { starting as hostedStarting, type StartingHost } from "./start.ts";
import { switchTo as hostedSwitchTo, type SwitchHost } from "./switch-to.ts";
import { sync as hostedSync, type SyncHost } from "./sync.ts";
import { treeHash } from "./tree.ts";
import {
	type LogHost,
	compare as versionCompare,
	fileAt as versionFileAt,
	log as versionLog,
	ribbon as versionRibbon,
	show as versionShow,
	viewAt as versionViewAt,
} from "./version-log.ts";
import {
	checkVersion as hostedCheckVersion,
	lastVersion as hostedLastVersion,
	versionMeta as hostedVersionMeta,
	type VersionMetaHost,
} from "./version-meta.ts";
import { modesOf } from "./view-changes.ts";
import { ViewCache } from "./views.ts";
import {
	isWhole as hostedIsWhole,
	wholeOut as hostedWholeOut,
	wholeRules as hostedWholeRules,
	type WholeHost,
} from "./whole-files.ts";
import { WriterAgents } from "./writer-agents.ts";

export { MemoryStore } from "./memory-store.ts";
export { checkReadPath, pathProblem } from "./path-rules.ts";
export { ProjectError } from "./project-error.ts";
export { shapeStamp, utf8Bytes } from "./project-helpers.ts";
export type * from "./project-types.ts";
export { differs } from "./view-changes.ts";

/** Entry kinds that had no time before #41; new ones get one. */
const UNTIMED = new Set<Entry["type"]>(["join", "sync", "news", "heard", "discard", "switch"]);

/** A start note lasts this long after the agent's last activity (#44). */
const NOTE_IDLE = 2 * 60 * 60 * 1000;
const WRITER_REOPEN = Symbol("verified writer checkpoint");
export interface WriterSource {
	readonly generation: number;
	readonly logLength: number;
	readonly sharedVersion: number;
}
interface WriterAdoption {
	source: WriterSource;
	next: number;
	ready: boolean;
}

/** A decoded entry is supplied by a host that binds its bytes to canonical authority. */
export type WriterAdoptionFrame = { seq: number; json: string } | { seq: number; bytes: number; entry: Entry };
function adoptionFrameBytes(frame: WriterAdoptionFrame): number {
	return "json" in frame
		? typeof frame.json === "string"
			? new TextEncoder().encode(frame.json).byteLength
			: NaN
		: frame.bytes;
}
function adoptionFrameEntry(frame: WriterAdoptionFrame): Entry {
	return "json" in frame ? (JSON.parse(frame.json) as Entry) : frame.entry;
}

export class Project {
	readonly #store: ProjectStore;
	readonly #writerStorage?: GraphStateStorage;
	readonly #graph: Graph;
	/** Views laid out from atom sets, cached under a byte budget (views.ts). */
	readonly #views: ViewCache;
	/** Each agent's draft files, under the key they were worked out for (#draftFiles). */
	readonly #draftFilesKept = new Map<string, { key: string; files: Set<string> }>();
	/** Each version's files and each path's history (pathindex.ts). */
	readonly #paths: PathIndex;
	/** For each atom (by seq) that wrote lines, the log position of the entry that recorded it (#46). */
	readonly #atomAt: number[] = [];
	/** Which atoms are in which space at which version (#46, disk-first 1): the rules live in spaces.ts. */
	readonly #membership = new Membership();
	get #spaces(): Map<string, Space> {
		return this.#membership.spaces;
	}
	readonly #agents = new Map<string, AgentState>();
	readonly #refusals: Refusal[] = [];
	/** Labels on shared's versions: name -> versions, ascending. */
	readonly #labels = new Map<string, number[]>();
	/** The newest tells and who has heard each (apply-entry.ts). */
	readonly #tells = new Map<number, TellRecord>();
	/**
	 * Entries applied but not stored yet, in order. Every applied entry is
	 * stored at the next flush, even when the call that applied it threw
	 * afterwards; otherwise the log could miss a join that later entries rely on.
	 */
	#pending: Entry[] = [];
	/**
	 * Whether something runs the merge queue's check (#39). Until the Worker has
	 * a checker it stays false, and `"queue": true` in avcs.json does nothing:
	 * publishes would otherwise wait for a check that never comes. Replay
	 * doesn't depend on it.
	 */
	checkerReady = false;
	readonly #now: (() => number) | undefined;
	readonly #whole: ProjectOptions["whole"];
	readonly #shapes: ProjectOptions["shapes"];
	/** For each log position, the newest time up to it (#41): time to position in one search. */
	readonly #timeAt: number[] = [];
	/** For each version of shared, the log position of the entry that made it (#41). */
	readonly #versionAt: number[] = [];
	/** The newest time any applied entry carries: the clock when none was given. */
	#lastTimeMemory = 0;
	get #lastTime(): number {
		return this.#writerStorage
			? ((this.#writerStorage.read("project:meta", "lastTime") as number | undefined) ?? 0)
			: this.#lastTimeMemory;
	}
	set #lastTime(value: number) {
		if (this.#writerStorage) this.#writerStorage.write("project:meta", "lastTime", value);
		else this.#lastTimeMemory = value;
	}
	/** Every change (#44), by id. */
	readonly #changes = new Map<number, ChangeRecord>();
	/** Each version's change, by "<draft or ''> <version>" (#44): what a note on its lines belongs to. */
	readonly #versionChange = new Map<string, number>();
	/** Every note (#44), by id. */
	readonly #notes = new Map<number, NoteRecord>();
	/** Mod versions (X-Abso-Client) in the order they first sent an edit (#41): the last is taken as the installed one. */
	#mods: string[] = [];
	/** The merge queue (#39), in order: publishes to shared waiting for their batch's check. */
	#queue: QueuedPublish[] = [];
	/** The newest note's id (#44). */
	#lastNoteMemory = 0;
	get #lastNote(): number {
		return this.#writerStorage
			? ((this.#writerStorage.read("project:meta", "lastNote") as number | undefined) ?? 0)
			: this.#lastNoteMemory;
	}
	set #lastNote(value: number) {
		if (this.#writerStorage) this.#writerStorage.write("project:meta", "lastNote", value);
		else this.#lastNoteMemory = value;
	}
	#queuedIdMemory = 0;
	get #queuedId(): number {
		return this.#writerStorage
			? ((this.#writerStorage.read("project:meta", "queuedId") as number | undefined) ?? 0)
			: this.#queuedIdMemory;
	}
	set #queuedId(value: number) {
		if (this.#writerStorage) this.#writerStorage.write("project:meta", "queuedId", value);
		else this.#queuedIdMemory = value;
	}
	/** Queued ids in the batch being checked now: not in the log, only for refusing an unqueue mid-check. */
	#checking = new Set<number>();
	/** How many entries the store holds: the log position of the next one (#41, the website's feed and replay). */
	#storedMemory = 0;
	get #stored(): number {
		return this.#writerStorage
			? ((this.#writerStorage.read("project:meta", "stored") as number | undefined) ?? 0)
			: this.#storedMemory;
	}
	set #stored(value: number) {
		if (this.#writerStorage) this.#writerStorage.write("project:meta", "stored", value);
		else this.#storedMemory = value;
	}
	/** Names on the lines a change replaced, by "<atom> <last replaced line>" (atoms never change). */
	#rule?: DefinitionRule;
	get #definitionRule(): DefinitionRule {
		this.#rule ??= new DefinitionRule(this.#graph, (atom, space) => this.#origin(atom, space));
		return this.#rule;
	}
	/** The newest announcement's id (announcements are news entries keyed "announce <id>"). */
	#announcedMemory = 0;
	get #announced(): number {
		return this.#writerStorage
			? ((this.#writerStorage.read("project:meta", "announced") as number | undefined) ?? 0)
			: this.#announcedMemory;
	}
	set #announced(value: number) {
		if (this.#writerStorage) this.#writerStorage.write("project:meta", "announced", value);
		else this.#announcedMemory = value;
	}
	#loading = false;

	readonly #hasBlob: (sha256: string) => boolean;

	constructor(store: ProjectStore, options: ProjectOptions = {}, checkpoint?: typeof WRITER_REOPEN) {
		if (options.indexAcceptedAtom && !options.writerStorage)
			throw Error("accepted atom indexing requires writer storage");
		this.#store = store;
		this.#writerStorage = options.writerStorage ? new CachedStateStorage(options.writerStorage) : undefined;
		if (this.#writerStorage) {
			const storage = this.#writerStorage;
			// A stored Graph cannot be replayed over itself. Check before any
			// constructor writes so an accidental reopen preserves the namespace.
			if (
				checkpoint !== WRITER_REOPEN &&
				((storage.read("atoms:meta", "length") as number | undefined) ||
					(storage.read('membership:"":versions:meta', "length") as number | undefined))
			)
				throw new Error("writer indexes already contain history; Project checkpoint reopen is required");
			this.#membership = new Membership(storage);
			this.#atomAt = storedArray(storage, "project:atom-at");
			this.#timeAt = storedArray(storage, "project:time-at");
			this.#versionAt = storedArray(storage, "project:version-at");
			this.#notes = new StoredMap(storage, "project:notes");
			this.#changes = new StoredMap(storage, "project:changes");
			this.#labels = new StoredMap(storage, "project:labels");
			this.#versionChange = new StoredMap(storage, "project:version-change");
			this.#refusals = storedArray(storage, "project:refusals");
			this.#agents = new WriterAgents(storage);
			if (checkpoint === WRITER_REOPEN) {
				this.#mods = storage.read("project:meta", "mods") as string[];
				this.#queue = storage.read("project:meta", "queue") as QueuedPublish[];
				const tells = storage.read("project:meta", "tells") as [
					number,
					Omit<TellRecord, "heard"> & { heard: [string, { at: number | undefined } | null][] },
				][];
				this.#tells = new Map(tells.map(([id, tell]) => [id, { ...tell, heard: new Map(tell.heard) }]));
			}
		}
		this.#hasBlob = options.hasBlob ?? (() => false);
		this.#now = options.now;
		this.#whole = options.whole;
		this.#shapes = options.shapes;
		// For tests (#46): AVCS_TEXT_FROM_LOG=1 runs a project on a MemoryStore with its text read back from the store.
		const testing =
			(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AVCS_TEXT_FROM_LOG ===
			"1";
		const entryAt =
			options.entryAt ??
			(testing && store instanceof MemoryStore ? (at: number) => (store as MemoryStore).entries[at]! : undefined);
		// An atom as its log entry stores it. Not stored yet: still in this call's pending entries; while loading, every entry is stored.
		const stored = (seq: number): Atom => {
			const at = this.#atomAt[seq]!;
			const entry = !this.#loading && at >= this.#stored ? this.#pending[at - this.#stored]! : entryAt!(at);
			if (entry?.type === "init" || entry?.type === "draft") return entry.atom;
			// A publish's or land's tie atom (#46: its lists are read back too).
			if (entry?.type === "publish" || entry?.type === "land") return entry.tie;
			throw new Error(`log entry ${at} holds no atom ${seq}`);
		};
		// Line text and each atom's deletes and claim keys stay in the log (#46), read back when asked for.
		this.#graph = this.#writerStorage
			? new Graph({ storage: this.#writerStorage, indexAcceptedAtom: options.indexAcceptedAtom })
			: entryAt
				? new Graph({ texts: (seq) => stored(seq).inserts.map((r) => r.lines), lists: (seq) => stored(seq) })
				: new Graph();
		this.#views = new ViewCache(this.#graph, options.readViewProvider);
		this.#paths = new PathIndex({
			graph: this.#graph,
			at: (space, version) => this.#at(space, version),
			viewAt: (space, version) => this.#viewAt(space, version),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
			shapes: this.#shapes,
		});
	}

	/** Rebuild a project from its stored entries. New entries go to `store`. */
	static load(entries: Iterable<Entry>, store: ProjectStore, options: ProjectOptions = {}): Project {
		const testing =
			(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AVCS_TEXT_FROM_LOG ===
			"1";
		if (testing && !options.entryAt && Array.isArray(entries)) {
			// Loaded from someone else's entries: its text is read back from them (and from the new store after them).
			const from = entries as Entry[];
			const after = store instanceof MemoryStore ? store : undefined;
			options = { ...options, entryAt: (at) => (at < from.length ? from[at]! : after!.entries[at - from.length]!) };
		}
		const project = new Project(store, options);
		project.#loading = true;
		for (const entry of entries) {
			project.#apply(entry);
			project.#stored++;
			project.#persistMutable();
		}
		project.#loading = false;
		project.#writeCheckpoint();
		return project;
	}

	/** Reopen committed writer indexes. The host supplies the authoritative canonical log length. */
	static openWriter(
		store: ProjectStore,
		storage: GraphStateStorage,
		logLength: number,
		options: Omit<ProjectOptions, "writerStorage"> = {},
	): Project {
		const adoption = storage.read("project:meta", "adoption") as WriterAdoption | undefined;
		if (adoption && !adoption.ready) throw new Error("writer adoption is incomplete");
		return Project.#openWriter(store, storage, logLength, options);
	}

	static #openWriter(
		store: ProjectStore,
		storage: GraphStateStorage,
		logLength: number,
		options: Omit<ProjectOptions, "writerStorage">,
	): Project {
		const checkpoint = storage.read("project:meta", "checkpoint") as
			| { format: number; logLength: number; atoms: number; version: number }
			| undefined;
		const length = (name: string) => (storage.read(`${name}:meta`, "length") as number | undefined) ?? 0;
		if (
			!Number.isSafeInteger(logLength) ||
			logLength < 1 ||
			checkpoint?.format !== 1 ||
			checkpoint.logLength !== logLength ||
			storage.read("project:meta", "stored") !== logLength ||
			length("project:time-at") !== logLength ||
			length("atoms") !== checkpoint.atoms ||
			length("project:atom-at") !== checkpoint.atoms ||
			length('membership:"":versions') !== checkpoint.version + 1 ||
			length("project:version-at") !== checkpoint.version + 1 ||
			!["mods", "queue", "tells"].every((key) => Array.isArray(storage.read("project:meta", key)))
		)
			throw new Error("writer checkpoint does not match the canonical log and indexes");
		return new Project(store, { ...options, writerStorage: storage }, WRITER_REOPEN);
	}

	/** Open a host-verified historical prefix. Its state must be immutable and
	 * scoped to canonical authority; adoption readiness describes the live writer,
	 * not whether this individual prefix has a complete checkpoint. */
	static openHistorical(
		storage: GraphStateStorage,
		logLength: number,
		scratch: GraphStateStorage,
		assertScope: () => void = () => {
			storage.read("project:meta", "checkpoint");
		},
		readViewProvider?: ProjectOptions["readViewProvider"],
	): Project {
		const refuse = (): never => {
			throw new Error("historical project is read-only");
		};
		const selected = (collection: string) => {
			// Revalidate the historical scope even when accessing derived scratch.
			assertScope();
			return collection.startsWith("projection-scratch:") ? scratch : storage;
		};
		return Project.#openWriter(
			{ append: refuse },
			{
				read: (collection, key) => selected(collection).read(collection, key),
				entries: (collection) => selected(collection).entries(collection),
				write: (collection, key, value) => {
					if (selected(collection) !== scratch) refuse();
					scratch.write(collection, key, value);
				},
				remove: (collection, key) => {
					if (selected(collection) !== scratch) refuse();
					scratch.remove(collection, key);
				},
				transaction: (body) => storage.transaction(() => scratch.transaction(body)),
			},
			logLength,
			{ readViewProvider },
		);
	}

	/**
	 * Derive one bounded page from the host's canonical frames. The host reads
	 * those frames from its own log and revalidates the source inside this same
	 * transaction. Partial adoption cannot be opened for normal operations.
	 */
	static adoptWriterPage(
		storage: GraphStateStorage,
		input: {
			source: WriterSource;
			from: number;
			frames: Iterable<WriterAdoptionFrame>;
			maxEntries: number;
			maxBytes: number;
			/** The host supplies disk-backed decoded entries and verified byte counts. */
			decodedFrames?: boolean;
			currentSource(): WriterSource;
			/** Select the host's derived historical revision before applying a frame.
			 * Each selected revision receives a complete Project checkpoint. */
			beginRevision?(logLength: number): void;
		},
		options: Omit<ProjectOptions, "writerStorage"> = {},
	): { next: number; ready: boolean; entries: number; bytes: number } {
		const same = (a: WriterSource, b: WriterSource) =>
			a.generation === b.generation && a.logLength === b.logLength && a.sharedVersion === b.sharedVersion;
		if (
			![input.source.generation, input.source.logLength, input.source.sharedVersion, input.from].every(
				(n) => Number.isSafeInteger(n) && n >= 0,
			) ||
			input.source.logLength < 1 ||
			!Number.isSafeInteger(input.maxEntries) ||
			input.maxEntries < 1 ||
			input.maxEntries > 256 ||
			!Number.isSafeInteger(input.maxBytes) ||
			input.maxBytes < 1 ||
			(input.maxBytes > 8_000_000 && input.decodedFrames !== true)
		)
			throw new Error("invalid writer adoption bounds or source");
		return storage.transaction(() => {
			if (!same(input.currentSource(), input.source))
				throw new Error("canonical source changed before writer adoption");
			const previous = storage.read("project:meta", "adoption") as WriterAdoption | undefined;
			if (
				(previous && (!same(previous.source, input.source) || previous.ready || previous.next !== input.from)) ||
				(!previous && input.from !== 0)
			)
				throw new Error("writer adoption source or cursor does not match");
			const noAppend: ProjectStore = {
				append: () => {
					throw new Error("adoption must never append canonical history");
				},
			};
			const project = previous
				? Project.#openWriter(noAppend, storage, input.from, options)
				: new Project(noAppend, { ...options, writerStorage: storage });
			project.#loading = true;
			let count = 0;
			let bytes = 0;
			for (const frame of input.frames) {
				if (input.decodedFrames && "json" in frame) throw new Error("decoded adoption requires decoded frames");
				const size = adoptionFrameBytes(frame);
				if (
					count >= input.maxEntries ||
					frame.seq !== input.from + count ||
					frame.seq >= input.source.logLength ||
					!Number.isSafeInteger(size) ||
					size < 1 ||
					size > input.maxBytes - bytes
				)
					throw new Error("writer adoption page exceeds bounds or has a noncontiguous frame");
				bytes += size;
				if (bytes > input.maxBytes) throw new Error("writer adoption page exceeds byte bound");
				input.beginRevision?.(frame.seq + 1);
				project.#apply(adoptionFrameEntry(frame));
				project.#stored++;
				project.#persistMutable();
				if (input.beginRevision) project.#writeCheckpoint();
				count++;
			}
			if (count === 0) throw new Error("writer adoption page must advance");
			project.#loading = false;
			const next = input.from + count;
			const ready = next === input.source.logLength;
			if (!same(input.currentSource(), input.source))
				throw new Error("canonical source changed during writer adoption");
			if (ready && project.version !== input.source.sharedVersion)
				throw new Error("adopted shared version differs from canonical source");
			project.#writeCheckpoint();
			storage.write("project:meta", "adoption", { source: input.source, next, ready } satisfies WriterAdoption);
			return { next, ready, entries: count, bytes };
		});
	}

	/**
	 * Extend derived historical indexes from an already checkpointed prefix.
	 * The host supplies only new canonical frames inside its commit transaction.
	 */
	static extendHistoricalPage(
		storage: GraphStateStorage,
		input: {
			from: number;
			frames: Iterable<WriterAdoptionFrame>;
			maxEntries: number;
			maxBytes: number;
			/** The host supplies disk-backed decoded entries and verified byte counts. */
			decodedFrames?: boolean;
			beginRevision(logLength: number): void;
			/** Verify both the saved prefix and the new frames against canonical authority. */
			validateAuthority(): void;
		},
	): { next: number; entries: number; bytes: number } {
		if (
			!Number.isSafeInteger(input.from) ||
			input.from < 1 ||
			!Number.isSafeInteger(input.maxEntries) ||
			input.maxEntries < 1 ||
			input.maxEntries > 256 ||
			!Number.isSafeInteger(input.maxBytes) ||
			input.maxBytes < 1 ||
			(input.maxBytes > 8_000_000 && input.decodedFrames !== true)
		)
			throw new Error("invalid historical extension bounds");
		const validate = () => {
			const result: unknown = input.validateAuthority();
			if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
				throw new Error("historical authority must be synchronous");
		};
		return storage.transaction(() => {
			validate();
			const project = Project.#openWriter(
				{
					append: () => {
						throw new Error("history derivation cannot append canonical entries");
					},
				},
				storage,
				input.from,
				{},
			);
			project.#loading = true;
			let entries = 0,
				bytes = 0;
			for (const frame of input.frames) {
				if (input.decodedFrames && "json" in frame) throw new Error("decoded adoption requires decoded frames");
				const size = adoptionFrameBytes(frame);
				if (
					entries >= input.maxEntries ||
					frame.seq !== input.from + entries ||
					!Number.isSafeInteger(size) ||
					size < 1 ||
					size > input.maxBytes - bytes
				)
					throw new Error("historical extension exceeds bounds or is not contiguous");
				bytes += size;
				if (bytes > input.maxBytes) throw new Error("historical extension exceeds byte bound");
				input.beginRevision(frame.seq + 1);
				project.#apply(adoptionFrameEntry(frame));
				project.#stored++;
				project.#persistMutable();
				project.#writeCheckpoint();
				entries++;
			}
			if (!entries) throw new Error("historical extension must advance");
			validate();
			return { next: input.from + entries, entries, bytes };
		});
	}

	/** Apply more entries to a replay copy. Never for the live project. */
	catchUp(entries: Iterable<Entry>): void {
		this.#loading = true;
		try {
			for (const entry of entries) {
				this.#apply(entry);
				this.#stored++;
			}
		} finally {
			this.#loading = false;
		}
	}

	/** The log position of the next entry: how many entries the log holds (#41). */
	get logLength(): number {
		return this.#stored;
	}

	get initialized(): boolean {
		return this.#shared.versions.length > 0;
	}

	/** The current shared version. */
	get version(): number {
		this.#needInit();
		return this.#shared.versions.length - 1;
	}

	/** Shared's files, for the push out to Artifacts. */
	files(): Record<string, string> {
		return this.#sharedView().files();
	}

	/** Shared's binary files, for the push out to Artifacts: path -> the SHA-256 of its bytes. Not in `files()`. */
	blobs(): Record<string, string> {
		return this.#sharedView().blobs();
	}

	/** Shared's executable files and links, for the push out to Artifacts: path -> mode. Other files are plain. */
	modes(): Modes {
		return modesOf(this.#sharedView());
	}

	/** Shared as a ReadView, for reading lines (blame, why). Don't hold on to it across calls. */
	sharedView(): ReadView {
		return this.#sharedView();
	}

	/** The agents the project knows, by name. */
	agents(): string[] {
		return [...this.#agents.keys()].sort();
	}

	/**
	 * An agent's unpublished changes, oldest first, and its view (its space at its base plus its changes). Read only.
	 * The view is laid out on first use: where asks every agent, most have no changes, and a big project has more
	 * agents than the view cache holds, so building every view cost each call about 0.7 s.
	 */
	draftOf(agentName: string): { atoms: AtomId[]; readonly view: ReadView } | undefined {
		const agent = this.#agents.get(agentName);
		if (!agent) return undefined;
		const view = () => this.#agentView(agent);
		return {
			atoms: this.#draft(agent),
			get view() {
				return view();
			},
		};
	}

	/** The shared version an atom was published in, or undefined while it's only in a draft. */
	versionOf(atom: AtomId): number | undefined {
		return this.#shared.publishedIn.get(atom);
	}

	/**
	 * Where an atom was published: shared if it's there, else the named draft
	 * that has it (by name), else undefined (it's only in a draft so far).
	 */
	publishOf(...args: Tail<Parameters<typeof hostedPublishOf>>): ReturnType<typeof hostedPublishOf> {
		return hostedPublishOf(this.#publishOfHost, ...args);
	}

	/** The newest version of shared, or of a named draft. */
	lastVersion(...args: Tail<Parameters<typeof hostedLastVersion>>): ReturnType<typeof hostedLastVersion> {
		return hostedLastVersion(this.#versionMetaHost, ...args);
	}

	/** Shared (null), then each named draft by name: every space with versions (abso issue 80). */
	spaceNames(): (string | null)[] {
		return [null, ...[...this.#spaces.keys()].filter((n) => n !== SHARED).sort()];
	}

	/** Who made a version of shared or a named draft, why and when, and a draft's shared base (abso issue 80). */
	versionMeta(...args: Tail<Parameters<typeof hostedVersionMeta>>): ReturnType<typeof hostedVersionMeta> {
		return hostedVersionMeta(this.#versionMetaHost, ...args);
	}

	/** Who published a version of shared, and why. */
	published(version: number): { agent: string; message: string; time: number } | undefined {
		const p = this.#shared.versions[version];
		return p && { agent: p.agent, message: p.message, time: p.time };
	}

	/** The graph, for reading (blame, history). Don't add to it. */
	get graph(): Graph {
		return this.#graph;
	}

	// Calls -------------------------------------------------------------------

	/** Create the project from a folder's text files. Empty files are skipped (the engine can't hold them). */
	init(...args: Tail<Parameters<typeof hostedInit>>): ReturnType<typeof hostedInit> {
		return hostedInit(this.#initHost, ...args);
	}

	/** An Edit, Write or MultiEdit from the hook, against the agent's view. */
	edit(...args: Tail<Parameters<typeof hostedEdit>>): ReturnType<typeof hostedEdit> {
		return hostedEdit(this.#editHost, ...args);
	}

	/** Whole files as the agent's folder has them; each is diffed against its view. */
	record(...args: Tail<Parameters<typeof hostedRecord>>): ReturnType<typeof hostedRecord> {
		return hostedRecord(this.#recordHost, ...args);
	}

	/** Add the agent's draft to its space (publish.ts). */
	publish(...args: Tail<Parameters<typeof hostedPublish>>): ReturnType<typeof hostedPublish> {
		return hostedPublish(this.#publishHost, ...args);
	}

	#publish(
		agent: AgentState,
		message: string,
		time: number,
		entries: Entry[],
		asIs = false,
		direct = false,
	): PublishAnswer {
		return hostedPublishDraft(this.#publishHost, agent, message, time, entries, asIs, direct);
	}

	/**
	 * How the agent's newest edit arrived (#41). The mod sends X-Abso-Client
	 * avcs-mod/<stamp>; the hook sends abso-cli/<version> (avcs-cli/ before #59) with the chat's
	 * session; abso record and git pushes send no session. Edits stored before
	 * the client was recorded have only the session: those count as the mod
	 * (the hook stands down where the mod is installed), with modCurrent null.
	 */
	#editsOf(agent: AgentState): {
		edits: EditsVia;
		modCurrent: boolean | null;
		lastEdit: number | null;
		joined: number | null;
	} {
		const last = agent.lastEdit;
		const joined = agent.joined ?? null;
		if (!last) return { edits: "none", modCurrent: null, lastEdit: null, joined };
		const { client, session } = last;
		if (client?.startsWith("avcs-mod/"))
			return { edits: "mod", modCurrent: client === this.#mods[this.#mods.length - 1], lastEdit: last.time, joined };
		if (client === undefined && session) return { edits: "mod", modCurrent: null, lastEdit: last.time, joined };
		return { edits: session ? "hook" : "commands", modCurrent: null, lastEdit: last.time, joined };
	}

	// Spellings and moves (#49) --------------------------------------------------------

	/** Refuse work whose paths would clash in shared (#49), before anything of it is written. */
	#checkClash(...args: Tail<Parameters<typeof hostedCheckClash>>): ReturnType<typeof hostedCheckClash> {
		return hostedCheckClash(this.#checkClashHost, ...args);
	}

	/**
	 * Move a file in the agent's draft (#49): its lines keep their ids, as with
	 * git mv, so blame and why follow it. The only way to change a file's case.
	 * Refused when `to` is another existing file, ignoring case.
	 */
	move(...args: Tail<Parameters<typeof hostedMove>>): ReturnType<typeof hostedMove> {
		return hostedMove(this.#moveHost, ...args);
	}

	// Files kept whole (#46) ----------------------------------------------------------

	/** avcs.json's `"whole": [globs]`: paths kept whole. From `config` when given (init), else shared's. */
	#wholeRules(config?: string): string[] {
		return hostedWholeRules(this.#wholeHost, config);
	}

	/**
	 * Whether a file is kept whole: its path matches avcs.json's "whole", its
	 * text passes WHOLE_LIMIT, or it is already a blob where it's going. The
	 * last makes it one-way: a file kept whole stays whole while it exists,
	 * even if it shrinks or the rule changes, so it never flips back and forth.
	 */
	#isWhole(path: string, length: number, view: ReadView | undefined, rules: readonly string[]): boolean {
		return hostedIsWhole(this.#wholeHost, path, length, view, rules);
	}

	/** Files and blobs with every whole file's text moved into the blob store. */
	#wholeOut(
		files: Readonly<Record<string, string | null>>,
		blobs: Readonly<Record<string, string>>,
		view: ReadView | undefined,
		config?: string,
	): { files: Record<string, string | null>; blobs: Record<string, string> } {
		return hostedWholeOut(this.#wholeHost, files, blobs, view, config);
	}

	// Changes (#44) -------------------------------------------------------------------

	/** The agent did something at `time`: its start note ends first if it had been idle over 2 hours. */
	#active(agent: AgentState, time: number): void {
		if (agent.starting && agent.lastActive !== undefined && time - agent.lastActive > NOTE_IDLE) {
			delete agent.starting;
			delete agent.noteAt;
		}
		if (agent.lastActive === undefined || time > agent.lastActive) agent.lastActive = time;
	}

	/** The agent's start note, unless it has been idle over 2 hours. */
	#liveNote(agent: AgentState): Starting | undefined {
		if (!agent.starting) return undefined;
		const now = this.#now?.() ?? this.#lastTime;
		return agent.lastActive !== undefined && now - agent.lastActive > NOTE_IDLE ? undefined : agent.starting;
	}

	/** The change the agent is working on at `time`: its named draft's, or its start note's; none for a lone publish. */
	#currentChange(agent: AgentState, time: number): number | undefined {
		if (agent.space !== SHARED) return this.#spaces.get(agent.space)?.startedAt;
		if (!agent.starting || agent.noteAt === undefined) return undefined;
		return agent.lastActive !== undefined && time - agent.lastActive > NOTE_IDLE ? undefined : agent.noteAt;
	}

	/** The position the next entry written will have. */
	get #nextAt(): number {
		return this.#stored + this.#pending.length;
	}

	#changeRecord(id: number, agent: AgentState, time: number, queuedNote?: Starting): ChangeRecord {
		return hostedChangeRecord(this.#changeHost, id, agent, time, queuedNote);
	}

	/** A publish or land joins its change. Entries from before changes: the start note named it, and the publish ended the note. */
	#joinChange(
		agent: AgentState,
		entry: Extract<Entry, { type: "publish" | "land" }>,
		at: number,
		draft: string | null,
		landed?: string,
	): void {
		hostedJoinChange(this.#changeHost, agent, entry, at, draft, landed);
	}

	/**
	 * One change (#44): the start note, named draft or publish that began it,
	 * each of its versions and the files they changed, what it settled, and its
	 * refusals. `id` is the log position of the entry that began it.
	 */
	change(id: number): ChangeAnswer {
		return hostedChange(this.#changeHost, id);
	}

	/** The files a version's changes name: cheap, for lists (the change page works out the net changes). */
	#namedFiles(space: Space, version: number): string[] {
		return hostedNamedFiles(this.#graph, space, version);
	}

	/**
	 * "Since you last looked" (#44): the changes with anything new at or after
	 * log position `since`, newest first, at most `limit`. Their files are the
	 * ones their changes name; the change page has the net changes.
	 */
	changes(
		since = 0,
		limit = 50,
		before?: number,
		issue?: number,
	): { since: number; next: number; changes: ChangeAnswer[]; older?: number } {
		return hostedChanges(this.#changeHost, since, limit, before, issue);
	}

	// Notes on lines (#44) --------------------------------------------------------------

	/**
	 * Leave a note on lines of a file (#44): lines `from` to `to` (1-based) as
	 * shared shows them now, as `of`'s draft shows them (to note work before
	 * it's published), or at `version`. Or answer a note with `reply`. The
	 * lines' authors, the change's agent and the thread hear it as news.
	 */
	note(
		agentName: string,
		body: NoteBody,
		time: number,
	): { id: number; change: number | null; lines: [number, number] } {
		this.#needInit();
		const entries: Entry[] = [];
		return this.#note(entries, () => ({ name: this.#agent(agentName, entries).name }), body, time);
	}

	/**
	 * A signed-in person's note from the website (#41). The Worker has checked
	 * who it is. The writer is recorded as "person:<id>" with `person`, never
	 * as an agent, and the news quotes the text.
	 */
	notePerson(
		person: { id: unknown; name: unknown },
		body: NoteBody,
		time: number,
	): { id: number; change: number | null; lines: [number, number] } {
		this.#needInit();
		const from = checkPerson(person);
		return this.#note([], () => ({ name: `person:${from.person.id}`, person: from }), body, time);
	}

	/** Close a person's own note (#41): only the person who wrote it can. */
	closeNotePerson(person: { id: unknown; name: unknown }, id: number, how: unknown, time: number): NoteAnswer {
		const from = checkPerson(person);
		return this.#closeNote(`person:${from.person.id}`, id, how, time, from);
	}

	#note(
		entries: Entry[],
		writerOf: () => { name: string; person?: PersonSender },
		body: NoteBody,
		time: number,
	): { id: number; change: number | null; lines: [number, number] } {
		return hostedWriteNote(this.#noteWriteHost, entries, writerOf, body, time);
	}

	/** The project's reviewers per area (#44): avcs.json's `"review": [{"paths": [...], "reviewer": "..."}]` in shared. */
	#reviewRules(): ReviewRule[] {
		if (["abso.json", "avcs.json"].every((path) => this.#graph.startCodeOf(path) === undefined)) return [];
		return reviewRulesIn(projectFileIn(this.#sharedView())?.text);
	}

	/** Each reviewer whose area these files fall in, the files that do, and whether it has noted change `id`. */
	#reviewersOf(files: readonly string[], id: number): { agent: string; files: string[]; read: boolean }[] {
		return reviewersOf(this.#reviewRules(), files, (agent) =>
			[...this.#notes.values()].some((n) => n.change === id && n.agent === agent),
		);
	}

	/** After a version of shared: the reviewers whose areas it touches hear of its change, once per change (#44). */
	#reviewNews(agent: AgentState, version: number, entries: Entry[]): void {
		const id = this.#versionChange.get(` ${version}`);
		if (id === undefined) return;
		const rec = this.#changes.get(id);
		const files = this.#namedFiles(this.#shared, version);
		for (const r of this.#reviewersOf(files, id)) {
			if (r.agent === agent.name) continue;
			const reviewer = this.#agents.get(r.agent);
			if (!reviewer) continue;
			const title =
				rec?.note?.text ?? (rec?.kind === "draft" ? `draft ${rec.draft}` : (rec?.versions[0]?.message ?? ""));
			this.#queueNews(reviewer, [reviewItem(agent.name, id, title, r.files, version)], entries);
		}
	}

	/** After a version of shared: each open objection whose lines it took out tells its writer (#44). */
	#addressedNews(agent: AgentState, version: number, entries: Entry[]): void {
		for (const n of this.#notes.values()) {
			if (n.kind !== "objection" || n.closed || n.reply !== undefined || n.agent === agent.name) continue;
			if (this.#noteAnswer(n).state !== "addressed") continue;
			const writer = this.#agents.get(n.agent);
			if (writer) this.#queueNews(writer, [addressedItem(agent.name, version, n)], entries);
		}
	}

	/** Close a note: only its writer can (#44). */
	closeNote(agentName: string, id: number, how: unknown, time: number): NoteAnswer {
		return this.#closeNote(agentName, id, how, time);
	}

	#closeNote(agentName: string, id: number, how: unknown, time: number, person?: PersonSender): NoteAnswer {
		return hostedCloseNote(this.#noteWriteHost, agentName, id, how, time, person);
	}

	/** Notes, oldest first: on a file, on a change, or only the ones still open. */
	notes(...args: Tail<Parameters<typeof hostedNotes>>): ReturnType<typeof hostedNotes> {
		return hostedNotes(this.#notesHost, ...args);
	}

	/** The change the newest of these lines was written in: its version's, or its author's current one if unpublished. */
	#changeOfLines(lines: readonly LineId[]): number | undefined {
		let newest: Atom | undefined;
		for (const l of lines) {
			const info = this.#graph.line(l);
			const atom = info && this.#graph.atom(info.atom);
			if (atom && (!newest || atom.seq > newest.seq)) newest = atom;
		}
		if (!newest) return undefined;
		for (const space of [this.#shared, ...[...this.#spaces.values()].filter((s) => s.name !== SHARED)]) {
			const v = space.publishedIn.get(newest.id);
			if (v !== undefined) return this.#versionChange.get(`${space.name === SHARED ? "" : space.name} ${v}`);
		}
		const author = this.#agents.get(newest.author);
		return author ? this.#currentChange(author, this.#now?.() ?? this.#lastTime) : undefined;
	}

	#noteAnswer(n: NoteRecord): NoteAnswer {
		return hostedNoteAnswer(this.#notesHost, n);
	}

	// The merge queue (#39) ------------------------------------------------------------

	/** Whether shared's avcs.json turns the merge queue on (`"queue": true`). */
	#queueOn(): boolean {
		return hostedQueueOn(this.#queueHost);
	}

	/** With the queue on, nothing lands in shared unchecked; land and pluck don't go through the queue yet. */
	#notQueuedYet(what: string): void {
		hostedNotQueuedYet(this.#queueHost, what);
	}

	/** Atoms of every queued publish, or only other agents' with `except`. */
	#queuedAtoms(except?: string): Set<AtomId> {
		return hostedQueuedAtoms(this.#queueHost, except);
	}

	/** Queue the agent's publish (#39). */
	#enqueue(
		agent: AgentState,
		message: string,
		time: number,
		draft: readonly AtomId[],
		resolves: readonly AtomId[],
		entries: Entry[],
	): PublishAnswer {
		return hostedEnqueue(this.#queueHost, agent, message, time, draft, resolves, entries);
	}

	/** The merge queue now (#39): waiting publishes in order, and which are in the batch being checked. */
	queue(...args: Tail<Parameters<typeof hostedQueue>>): ReturnType<typeof hostedQueue> {
		return hostedQueue(this.#queueHost, ...args);
	}

	/** Mark the first `n` queued publishes as the batch being checked (0 ends it). Not logged. */
	queueChecking(...args: Tail<Parameters<typeof hostedQueueChecking>>): ReturnType<typeof hostedQueueChecking> {
		return hostedQueueChecking(this.#queueHost, ...args);
	}

	/** Shared with the first `n` queued publishes on top (#39): the files a batch's check runs on, and their tree hash. */
	queueCandidate(...args: Tail<Parameters<typeof hostedQueueCandidate>>): ReturnType<typeof hostedQueueCandidate> {
		return hostedQueueCandidate(this.#queueHost, ...args);
	}

	/** The tree hash of a version of shared (#39): it equals a candidate's when that's what landed. */
	treeAt(version: number): string {
		const view = this.viewAt(version);
		return treeHash({ files: view.files(), modes: modesOf(view), blobs: view.blobs() });
	}

	/**
	 * Land the first `n` queued publishes (#39), in order, each as its own
	 * version, after their batch passed. Each tells others what arrived, its
	 * author that it landed, and the authors of what it settled what it kept.
	 */
	queueLand(...args: Tail<Parameters<typeof hostedQueueLand>>): ReturnType<typeof hostedQueueLand> {
		return hostedQueueLand(this.#queueHost, ...args);
	}

	/**
	 * Take a queued publish out (#39): its check failed, or its author withdrew
	 * it. Its changes are simply still in its author's draft. Later queued
	 * publishes that build on its changes come out with it.
	 */
	queuePull(...args: Tail<Parameters<typeof hostedQueuePull>>): ReturnType<typeof hostedQueuePull> {
		return hostedQueuePull(this.#queueHost, ...args);
	}

	/** The agent withdraws its queued publishes (#39): refused while one is in the batch being checked. */
	unqueue(...args: Tail<Parameters<typeof hostedUnqueue>>): ReturnType<typeof hostedUnqueue> {
		return hostedUnqueue(this.#queueHost, ...args);
	}

	/**
	 * Correct the message of the agent's newest publish in its space (#27).
	 * Only the message changes: shared only grows, so a version's changes are
	 * fixed by publishing again (or dropping it). The log keeps the original.
	 */
	amend(...args: Tail<Parameters<typeof hostedAmend>>): ReturnType<typeof hostedAmend> {
		return hostedAmend(this.#amendHost, ...args);
	}

	/**
	 * Put a label on a version of shared (the newest by default), or take it
	 * off with `remove`. A label can mark many versions ("passed-ci"); a folder
	 * follows the newest with `sync {label}`.
	 */
	label(...args: Tail<Parameters<typeof hostedLabel>>): ReturnType<typeof hostedLabel> {
		return hostedLabel(this.#labelHost, ...args);
	}

	/**
	 * Drop published versions of shared (#10): a new shared version whose set
	 * leaves out their changes. Later work that doesn't depend on them stays;
	 * history keeps them. When later published work built on them, they are
	 * refused with that work listed, unless `withDependents`, which drops it
	 * too. Unpublished work that builds on them (an agent's draft, a named
	 * draft not yet landed) always refuses it: drop never touches it.
	 */
	drop(
		agentName: string,
		versions: readonly number[],
		message: string,
		time: number,
		options: { withDependents?: boolean } = {},
	): DropAnswer {
		return hostedDrop(this.#dropHost, agentName, versions, message, time, options);
	}

	/**
	 * After a sync, merge files where the agent's draft and the newer work
	 * collide, the way git merges a file (#25, Fuzzer): from the agent's old
	 * base, its draft's text and the newer text. Changes both made identically
	 * are kept once; changes on one side are kept. Only when every file
	 * involved merges with no conflict are the draft's changes to them dropped
	 * (a discard entry) and made again as the merged text. Otherwise nothing
	 * changes, and the collision stands with both sides' lines in the file.
	 */
	#mergeIdentical(
		agent: AgentState,
		before: ReadView,
		oldBase: ReadonlySet<AtomId>,
		oldVersion: number,
		time: number,
		entries: Entry[],
	): MergedLine[] {
		return hostedMergeIdentical(this.#mergeHost, agent, before, oldBase, oldVersion, time, entries);
	}

	/**
	 * Names the agent's draft defines at the top level of a file where other
	 * work defines them too, so they are defined twice there (#25, Fuzzer).
	 */
	#duplicates(agent: AgentState): Collision[] {
		return duplicateCollisions(this.#collisionHost, agent);
	}

	/**
	 * Draft changes that build on atoms a set doesn't have (a drop took them
	 * out): the files they touch. Those changes can't move onto that set.
	 */
	#strandedFiles(draft: readonly AtomId[], set: ReadonlySet<AtomId>): string[] {
		return strandedFiles(this.#graph, draft, set);
	}

	/** Answer a refusal, and log it (an entry that changes nothing but the counts). */
	#refuse(...args: Tail<Parameters<typeof hostedRefuse>>): ReturnType<typeof hostedRefuse> {
		return hostedRefuse(this.#refuseHost, ...args);
	}

	/**
	 * Tell other agents something, as news: "Announcement from <agent>:
	 * <text>". It reaches each one with its next edit, record or news call.
	 * `to` names agents; without it, every other agent the project has now.
	 */
	announce(...args: Tail<Parameters<typeof hostedAnnounce>>): ReturnType<typeof hostedAnnounce> {
		return hostedAnnounce(this.#announceHost, ...args);
	}

	/**
	 * A signed-in person's announcement from the website (#41). The Worker has
	 * checked who sent it; the engine records it on each recipient's news with
	 * `from`, and never makes the person an agent. The text is JSON-quoted, so
	 * a line break in it can't pass for another item.
	 */
	announcePerson(...args: Tail<Parameters<typeof hostedAnnouncePerson>>): ReturnType<typeof hostedAnnouncePerson> {
		return hostedAnnouncePerson(this.#announceHost, ...args);
	}

	/**
	 * Say what the agent is starting on (#37, #13), before any edit lands:
	 * `text`, and the files it expects to change if it knows them. Nothing is
	 * locked or refused. where and status show it until the agent publishes,
	 * lands, or sends null. The answer names who already has unpublished
	 * changes in, or a starting note on, those files; they hear of it too.
	 */
	starting(...args: Tail<Parameters<typeof hostedStarting>>): ReturnType<typeof hostedStarting> {
		return hostedStarting(this.#startingHost, ...args);
	}

	/** Every agent's starting note, by agent name. */
	startingNotes(): ReturnType<typeof hostedStartingNotes> {
		return hostedStartingNotes(this.#notesHost);
	}

	#openCollisions(agent: AgentState): { collisions?: AgentStatus["collisions"] } {
		return hostedOpenCollisions(this.#markerHost, agent);
	}

	/**
	 * News when an edit leaves a file holding blocks of collision markers
	 * (#11): how many, and how to settle them. Again whenever the count changes.
	 */
	#markedNews(agent: AgentState, files: readonly string[], entries: Entry[]): void {
		const marked = new Set(this.#markedFiles(agent));
		const view = this.#agentView(agent);
		const items: NewsItem[] = [];
		for (const file of [...new Set(files)].sort()) {
			if (!marked.has(file) || !view.hasFile(file)) continue;
			const n = blocksIn(view.lines(file).map((l) => l.text)).length;
			if (n === 0) continue;
			items.push(markedItem(this.#draft(agent)[0] ?? "", file, n));
		}
		this.#queueNews(agent, items, entries);
	}

	/** The collided changes behind each block whose marker lines `atom` deletes (#11). */
	#markersSettled(agent: AgentState, view: ReadView, atom: Atom): AtomId[] {
		return hostedMarkersSettled(this.#markerHost, agent, view, atom);
	}

	/** Files where a sync wrote the agent collision markers in its current space (#11). */
	#markedFiles(agent: AgentState): string[] {
		return hostedMarkedFiles(agent);
	}

	/** The blocks of markers still in the agent's files, as collisions (#11): listed by sync and status. */
	#markedCollisions(agent: AgentState): Collision[] {
		return hostedMarkedCollisions(this.#markerHost, agent);
	}

	/**
	 * Marker lines the agent's draft adds (#11), as collisions: each
	 * well-formed block, and any marker line left outside one. Only the labeled
	 * lines the engine writes count, so a document that shows markers can be
	 * published.
	 */
	#markerCollisions(agent: AgentState): Collision[] {
		return hostedMarkerCollisions(this.#markerHost, agent);
	}

	/** One line of news for each other author whose marked collision a publish settled (#11): what was kept, and any lines lost. */
	#settledNews(agent: AgentState, version: number, settled: readonly Settled[], entries: Entry[]): void {
		for (const s of settled) {
			const other = this.#agents.get(s.theirs.agent);
			if (!other || other === agent) continue;
			this.#queueNews(other, [settledItem(agent.name, version, s)], entries);
		}
	}

	/**
	 * The files the agent's unpublished changes touch, in its own view. Kept per agent under what they're
	 * made of: its view's key and its draft. Most agents haven't moved since the last
	 * status, and the view cache holds fewer views than a big project has agents, so working them out again
	 * on every call cost about 0.5 s on abso. A copy goes out, so no caller can change what's kept.
	 */
	#draftFiles(agent: AgentState): Set<string> {
		const key = `${this.#agentViewKey(agent)}|${this.#draft(agent).join(",")}`;
		let kept = this.#draftFilesKept.get(agent.name);
		if (kept?.key !== key) {
			kept = { key, files: hostedDraftFiles(this.#overlapHost, agent) };
			this.#draftFilesKept.set(agent.name, kept);
		}
		return new Set(kept.files);
	}

	/** Other agents in the agent's space whose unpublished changes or starting note meet `patterns`. */
	#overlaps(...args: Tail<Parameters<typeof hostedOverlaps>>): ReturnType<typeof hostedOverlaps> {
		return hostedOverlaps(this.#overlapHost, ...args);
	}

	/**
	 * News the first time a draft touches a file someone else in its space has
	 * unpublished changes in, or a starting note on (#37): one line per file and agent, once per draft. It tells; it never stops
	 * the edit.
	 */
	#overlapNews(...args: Tail<Parameters<typeof hostedOverlapNews>>): ReturnType<typeof hostedOverlapNews> {
		return hostedOverlapNews(this.#overlapHost, ...args);
	}

	/** Hand over the news waiting for an agent (collisions, definitions, moves, announcements), once. */
	news(agentName: string): { news: string[]; items: { text: string; at: number | null }[] } {
		const entries: Entry[] = [];
		const agent = this.#agent(agentName, entries);
		const items = agent.news.map((text, i) => ({ text, at: agent.newsAt[i] ?? null }));
		const news = this.#takeNews(agent, entries);
		this.#flush(entries);
		return { news, items };
	}

	/** Refused publishes and lands, newest first (`limit` defaults to 50), with counts over all of them. */
	refusals(...args: Tail<Parameters<typeof hostedRefusals>>): ReturnType<typeof hostedRefusals> {
		return hostedRefusals(this.#refuseHost, ...args);
	}

	/**
	 * Move the agent's base to its space's newest version. Returns every file
	 * whose text in its view changes (null when it's gone), and the collisions
	 * it now has to settle. A first sync returns every file (that's how a
	 * folder joins).
	 */
	sync(...args: Tail<Parameters<typeof hostedSync>>): ReturnType<typeof hostedSync> {
		return hostedSync(this.#syncHost, ...args);
	}

	/**
	 * Move the agent to a named draft, or back to shared with null. Its
	 * unpublished changes stay parked on the server in the space it leaves,
	 * and what it parked in the space it moves to comes back. Nothing is lost
	 * and nothing has to be published or stashed first. A new named draft
	 * starts on shared's newest version; with `carry`, the agent's current
	 * unpublished changes move into it instead of being parked. Answers like a
	 * sync: the files that change in its folder.
	 */
	switchTo(...args: Tail<Parameters<typeof hostedSwitchTo>>): ReturnType<typeof hostedSwitchTo> {
		return hostedSwitchTo(this.#switchHost, ...args);
	}

	/**
	 * Move the agent's named draft onto shared's newest version. The draft's
	 * agents see it when they next sync; anything it collides with is theirs
	 * to settle before the draft lands.
	 */
	syncDraft(agentName: string, time: number): DraftSyncAnswer {
		const entries: Entry[] = [];
		const agent = this.#agent(agentName, entries);
		const space = this.#namedSpaceOf(agent);
		const ownOnly = [...space.own].filter((id) => !this.#shared.own.has(id) && !this.#shared.droppedIn.has(id));
		const stranded = this.#strandedFiles(ownOnly, this.#shared.own);
		if (stranded.length > 0) {
			throw new ProjectError(
				"conflict",
				`draft ${space.name} has changes to ${stranded.join(", ")} that build on lines a drop took out of shared`,
			);
		}
		if (sharedBaseOf(space) !== this.version) {
			entries.push({
				type: "space-sync",
				space: space.name,
				agent: agent.name,
				time,
				version: last(space) + 1,
				sharedBase: this.version,
			});
			this.#apply(entries[entries.length - 1]!);
		}
		this.#flush(entries);
		return { draft: space.name, version: last(space), sharedBase: sharedBaseOf(space) };
	}

	/**
	 * Land the agent's named draft in shared as one unit: every change
	 * published into it that shared doesn't have yet. Refused, like a publish,
	 * when those changes collide with work that landed in shared after the
	 * draft's base; sync the draft, settle, and land again.
	 */
	land(...args: Tail<Parameters<typeof hostedLand>>): ReturnType<typeof hostedLand> {
		return hostedLand(this.#landHost, ...args);
	}

	/**
	 * What landing `changes` of a named draft would collide with in shared now (#41, the Drafts page reads it
	 * too): the same pairs and definitions land refuses on.
	 */
	#landCollisions(
		space: Space,
		changes: AtomId[],
		pick: boolean,
	): { collisions: Collision[]; newer: ReadonlySet<AtomId>; union: ReadonlySet<AtomId> } {
		return hostedLandCollisions(this.#landHost, space, changes, pick);
	}

	/**
	 * A named draft's state in one read (#41, the Drafts page, D3 and D16): the shared version it builds on and
	 * how far behind shared that is, its versions, when its first edit was, who works in it, and what landing it
	 * now would collide with (the same check land makes, so nothing is written).
	 */
	draftState(...args: Tail<Parameters<typeof hostedDraftState>>): ReturnType<typeof hostedDraftState> {
		return hostedDraftState(this.#draftStateHost, ...args);
	}

	#land(
		agent: AgentState,
		message: string,
		time: number,
		entries: Entry[],
		pick?: { space: Space; changes: AtomId[] },
	): LandAnswer {
		return hostedLandDraft(this.#landHost, agent, message, time, entries, pick);
	}

	/**
	 * Take part of a named draft into shared (#27): the changes of some of its
	 * versions, as one new version of shared, checked for collisions like a
	 * land. When they build on other versions of the draft, those are listed
	 * and it is refused, unless `withDependencies` takes them too. The draft
	 * stays as it is; landing it later brings in only what's left.
	 */
	pluck(
		agentName: string,
		draftName: string,
		versions: readonly number[],
		message: string,
		time: number,
		options: { withDependencies?: boolean } = {},
	): PluckAnswer {
		return hostedPluck(this.#pluckHost, agentName, draftName, versions, message, time, options);
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
	ingest(...args: Tail<Parameters<typeof hostedIngest>>): ReturnType<typeof hostedIngest> {
		return hostedIngest(this.#ingestHost, ...args);
	}

	// Reading history, and discarding -------------------------------------------

	#checkVersion(space: Space, version: number): void {
		hostedCheckVersion(space, version);
	}

	/**
	 * Discard the agent's unpublished changes to some files (all of them with
	 * `files` null), like git restore. Changes that touch only those files and
	 * that no kept change builds on leave the draft; anything left over is
	 * undone by a new change that puts the files back. Answers with each
	 * file's text now, for the folder.
	 */
	restore(...args: Tail<Parameters<typeof hostedRestore>>): ReturnType<typeof hostedRestore> {
		return hostedRestore(this.#restoreHost, ...args);
	}

	/** The space options name: an agent's current space with `agent`, else the named draft, else shared. */
	#spaceFor(options: { draft?: string | null; agent?: string }): Space {
		if (options.agent !== undefined) {
			const agent = this.#agents.get(options.agent);
			if (!agent) throw new ProjectError("bad-request", `there is no agent ${JSON.stringify(options.agent)}`);
			return this.#spaceOf(agent);
		}
		return this.#spaceNamed(options.draft ?? null);
	}

	#spaceNamed(name: string | null): Space {
		const key = name === null ? SHARED : checkDraftName(name);
		const space = this.#spaces.get(key);
		if (!space) throw new ProjectError("bad-request", `there is no draft ${String(name)}`);
		return space;
	}

	/**
	 * The stored spelling a read means (#41, F7, the rule #49 set for writes):
	 * the path itself, else the one file it matches by pathKey; failing that,
	 * the one file ever in the view it matches, for a file since taken out.
	 * A path that matches two files is answered exactly.
	 */
	spellingIn(view: ReadView, path: string): string {
		if (view.hasFile(path)) return path;
		const key = pathKey(path);
		const live = view.knownPaths().filter((p) => pathKey(p) === key && view.hasFile(p));
		if (live.length > 0) return live.length === 1 ? live[0]! : path;
		const known = view.knownPaths();
		if (known.includes(path)) return path;
		const gone = known.filter((p) => pathKey(p) === key);
		return gone.length === 1 ? gone[0]! : path;
	}

	// Applying entries ------------------------------------------------------------

	#apply(entry: Entry): void {
		// Entries written before #41 have no time on these kinds; new ones do, so replay can place them.
		const kept =
			this.#loading || !UNTIMED.has(entry.type) || "time" in entry ? entry : ({ ...entry, time: Date.now() } as Entry);
		if (!this.#loading) this.#pending.push(kept);
		const at = this.#loading ? this.#stored : this.#stored + this.#pending.length - 1;
		// Positions by time (#41, the website): the newest time up to each position, as the log holds it.
		const keptTime =
			kept.type === "draft" ? kept.atom.time : "time" in kept && typeof kept.time === "number" ? kept.time : undefined;
		const prior = at > 0 ? this.#timeAt[at - 1]! : 0;
		this.#timeAt[at] = keptTime !== undefined && keptTime > prior ? keptTime : prior;
		const versionsBefore = this.#spaces.get(SHARED)?.versions.length ?? 0;
		try {
			this.#applyEntry(entry, at, keptTime);
		} finally {
			// Positions by version: where each version of shared was made.
			const versionsAfter = this.#spaces.get(SHARED)?.versions.length ?? 0;
			for (let v = versionsBefore; v < versionsAfter; v++) this.#versionAt[v] = at;
		}
	}

	/**
	 * The log position for a time or a version of shared (#41, the website):
	 * for `time`, the position just after the last entry no later than it
	 * (entries with no time take their predecessor's); for `version`, the
	 * position just after the entry that made it. `end` is the log's length.
	 */
	position(q: { time?: number; version?: number }): { position: number; end: number } {
		const end = this.#timeAt.length;
		if (q.version !== undefined) {
			if (!Number.isInteger(q.version) || q.version < 0 || q.version >= this.#versionAt.length)
				throw new ProjectError("not-found", `there is no version ${String(q.version)}`);
			return { position: this.#versionAt[q.version]! + 1, end };
		}
		if (typeof q.time !== "number" || !Number.isFinite(q.time))
			throw new ProjectError("bad-request", "position needs ?time= or ?version=");
		// The newest time up to each position never goes down, so halve.
		let lo = 0;
		let hi = end;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#timeAt[mid]! <= q.time) lo = mid + 1;
			else hi = mid;
		}
		return { position: lo, end };
	}

	#applyEntry(entry: Entry, at: number, time: number | undefined): void {
		hostedApplyEntry(this.#applyEntryHost, entry, at, time);
	}

	/** Apply entries and store them. */
	#commit(entries: Entry[]): void {
		for (const e of entries) this.#apply(e);
		this.#flush(entries);
	}

	/** Store entries that are already applied. */
	#flush(_entries: readonly Entry[]): void {
		if (this.#pending.length === 0) return;
		const out = this.#pending;
		this.#store.append(out);
		this.#persistMutable();
		this.#pending = [];
		this.#stored += out.length;
		this.#writeCheckpoint();
	}

	#writeCheckpoint(): void {
		this.#writerStorage?.write("project:meta", "checkpoint", {
			format: 1,
			logLength: this.#stored,
			atoms: this.#graph.size,
			version: this.version,
		});
	}

	#persistMutable(): void {
		if (!this.#writerStorage) return;
		if (this.#agents instanceof WriterAgents) this.#agents.flush();
		this.#writerStorage.write("project:meta", "mods", this.#mods);
		this.#writerStorage.write("project:meta", "queue", this.#queue);
		this.#writerStorage.write(
			"project:meta",
			"tells",
			[...this.#tells].map(([id, tell]) => [id, { ...tell, heard: [...tell.heard] }]),
		);
	}

	/**
	 * The agent an entry names. Before every applied entry was stored, a call
	 * that joined an agent and then threw could leave the join out of the log
	 * while later entries named the agent. The lost join had the version the
	 * project was at then, which is the version now, during replay.
	 */
	#agentOf(name: string): AgentState {
		let agent = this.#agents.get(name);
		if (!agent) {
			this.#apply({ type: "join", agent: name, version: this.#shared.versions.length - 1 });
			agent = this.#agents.get(name)!;
		}
		return agent;
	}

	// Agents, spaces and views ----------------------------------------------------

	get #shared(): Space {
		return this.#spaces.get(SHARED)!;
	}

	#needInit(): void {
		if (!this.initialized) throw new ProjectError("not-initialized", "the project has no files yet; init it first");
	}

	#agent(name: string, entries: Entry[]): AgentState {
		this.#needInit();
		if (typeof name !== "string" || !NAME.test(name) || name === "init") {
			throw new ProjectError(
				"bad-agent",
				`bad agent name ${JSON.stringify(name)}: letters, digits, '.', '_' and '-', up to 64`,
			);
		}
		let agent = this.#agents.get(name);
		if (!agent) {
			const join: Entry = { type: "join", agent: name, version: this.version };
			entries.push(join);
			this.#apply(join);
			agent = this.#agents.get(name)!;
		}
		return agent;
	}

	#spaceOf(agent: AgentState): Space {
		return this.#spaces.get(agent.space)!;
	}

	#namedSpaceOf(agent: AgentState): Space {
		if (agent.space === SHARED) {
			throw new ProjectError("bad-request", `${agent.name} works in shared, not a named draft; switch to one first`);
		}
		return this.#spaceOf(agent);
	}

	// History reads (#41), in history.ts behind HistoryHost (#46, disk-first 1) ------------------------

	#host?: HistoryHost;
	/** The project as the history reads see it: the seam the derived tables plug into (abso issues 48, 79). */
	get #history(): HistoryHost {
		this.#host ??= {
			graph: this.#graph,
			agents: this.#agents,
			spaces: this.#spaces,
			needInit: () => this.#needInit(),
			spaceNamed: (name) => this.#spaceNamed(name),
			checkVersion: (space, version) => this.#checkVersion(space, version),
			viewAt: (space, version) => this.#viewAt(space, version),
			agentView: (agent) => this.#agentView(agent as AgentState),
			spellingIn: (view, asked) => this.spellingIn(view, asked),
			pathsOf: (space) => this.#paths.pathsOf(space),
			lastChange: (space, version) => this.#paths.lastChange(space, version),
			atOrBefore: (list, version) => PathIndex.atOrBefore(list, version),
			removedIn: (space, from, to, line) => this.#paths.removedIn(space, from, to, line),
		};
		return this.#host;
	}

	/** One folder at a version (history.ts). */
	tree(...args: Tail<Parameters<typeof historyTree>>): ReturnType<typeof historyTree> {
		return historyTree(this.#history, ...args);
	}

	/** A path's life at a version (history.ts). */
	pathLife(...args: Tail<Parameters<typeof historyPathLife>>): ReturnType<typeof historyPathLife> {
		return historyPathLife(this.#history, ...args);
	}

	/** Where lines went after a version (history.ts). */
	follow(...args: Tail<Parameters<typeof historyFollow>>): ReturnType<typeof historyFollow> {
		return historyFollow(this.#history, ...args);
	}

	// The version list (log, ribbon, show), in version-log.ts behind LogHost ----------------------------

	#logs?: LogHost;
	get #logHost(): LogHost {
		this.#logs ??= {
			graph: this.#graph,
			paths: this.#paths,
			labels: this.#labels,
			shared: () => this.#shared,
			needInit: () => this.#needInit(),
			spaceFor: (options) => this.#spaceFor(options),
			checkVersion: (space, version) => this.#checkVersion(space, version),
			viewAt: (space, version) => this.#viewAt(space, version),
			view: (set) => this.#view(set),
			at: (space, version) => this.#at(space, version),
			spellingIn: (view, path) => this.spellingIn(view, path),
			versionChange: (space, version) =>
				this.#versionChange.get(`${space.name === SHARED ? "" : space.name} ${version}`),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
		};
		return this.#logs;
	}

	/** The versions of shared (or of a named draft), newest first (version-log.ts). */
	log(...args: Tail<Parameters<typeof versionLog>>): ReturnType<typeof versionLog> {
		return versionLog(this.#logHost, ...args);
	}

	/** Shared's versions in one small answer, for the website's version ribbon (version-log.ts). */
	ribbon(): ReturnType<typeof versionRibbon> {
		return versionRibbon(this.#logHost);
	}

	/** One version of shared (or of a named draft) and the files it changed (version-log.ts). */
	show(...args: Tail<Parameters<typeof versionShow>>): ReturnType<typeof versionShow> {
		return versionShow(this.#logHost, ...args);
	}

	/** A file as it was at a version of shared (or a named draft) (version-log.ts). */
	fileAt(...args: Tail<Parameters<typeof versionFileAt>>): ReturnType<typeof versionFileAt> {
		return versionFileAt(this.#logHost, ...args);
	}

	/** Every file that differs between two versions of shared (or a named draft) (version-log.ts). */
	compare(...args: Tail<Parameters<typeof versionCompare>>): ReturnType<typeof versionCompare> {
		return versionCompare(this.#logHost, ...args);
	}

	/** A version of shared (or of a named draft) as a ReadView (version-log.ts). */
	viewAt(...args: Tail<Parameters<typeof versionViewAt>>): ReturnType<typeof versionViewAt> {
		return versionViewAt(this.#logHost, ...args);
	}

	// Whether agents' drafts would collide, in draft-collisions.ts behind DraftCollisionHost -------------

	#draftCollisionHost?: DraftCollisionHost;
	get #draftCollisions(): DraftCollisionHost {
		this.#draftCollisionHost ??= {
			graph: this.#graph,
			agents: this.#agents,
			needInit: () => this.#needInit(),
			shared: () => this.#shared,
			sharedView: () => this.#sharedView(),
			definitionRule: () => this.#definitionRule,
			draft: (agent) => this.#draft(agent as AgentState),
			agentView: (agent) => this.#agentView(agent as AgentState),
			view: (set) => this.#view(set),
			pairs: (draft, against, settled) => this.#pairs(draft, against, settled),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
		};
		return this.#draftCollisionHost;
	}

	/** Whether agents' unpublished changes would collide, by the publish rule (draft-collisions.ts). */
	collisions(...args: Tail<Parameters<typeof draftCollisions>>): ReturnType<typeof draftCollisions> {
		return draftCollisions(this.#draftCollisions, ...args);
	}

	// An agent's unpublished changes, in draft-diff.ts behind DraftDiffHost -----------------------------

	#draftDiffHost?: DraftDiffHost;
	get #draftDiff(): DraftDiffHost {
		this.#draftDiffHost ??= {
			agents: this.#agents,
			needInit: () => this.#needInit(),
			draft: (agent) => this.#draft(agent as AgentState),
			agentView: (agent) => this.#agentView(agent as AgentState),
			view: (set) => this.#view(set),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
		};
		return this.#draftDiffHost;
	}

	/** What the agent's unpublished changes do, file by file (draft-diff.ts). Creates the agent if needed. */
	diff(agentName: string): DiffAnswer {
		const entries: Entry[] = [];
		const answer = diffOfAgent(this.#draftDiff, this.#agent(agentName, entries));
		this.#flush(entries);
		return answer;
	}

	/** An agent's draft diff for a reader: never creates the agent, never writes (draft-diff.ts). */
	diffOf(...args: Tail<Parameters<typeof draftDiffOf>>): ReturnType<typeof draftDiffOf> {
		return draftDiffOf(this.#draftDiff, ...args);
	}

	// Unpublished deletes-and-writes of the same text become a move (express-moves.ts) -----------------

	#movesHost?: ExpressMovesHost;
	get #expressMovesHost(): ExpressMovesHost {
		this.#movesHost ??= {
			graph: this.#graph,
			draft: (agent) => this.#unqueuedDraft(agent),
			beforeDraft: (agent, draft) => {
				const base = this.#at(this.#spaceOf(agent), agent.base);
				if (draft.some((id) => base.has(id)))
					return this.#view(differenceSet(this.#agentView(agent).set, new StableOverlaySet(draft)));
				const removed = new Set(draft),
					kept = agent.mine.filter((id) => !removed.has(id));
				return kept.length === 0
					? this.#viewAt(this.#spaceOf(agent), agent.base)
					: this.#viewKeyed(`a ${agent.space}@${agent.base}+${kept.join(",")}`, () => unionOverlay(base, kept));
			},
			agentView: (agent) => this.#agentView(agent),
			view: (set) => this.#view(set),
			apply: (entry) => this.#apply(entry),
			addDraft: (agent, view, input, time, meta, entries) => this.#addDraft(agent, view, input, time, meta, entries),
			recordFile: (agent, view, path, text, time, meta, entries, mode) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode),
		};
		return this.#movesHost;
	}

	// Files kept whole, in whole-files.ts behind WholeHost ----------------------------------------------

	#wholes?: WholeHost;
	get #wholeHost(): WholeHost {
		this.#wholes ??= {
			initialized: () => this.initialized,
			sharedView: () => this.#sharedView(),
			whole: this.#whole,
		};
		return this.#wholes;
	}

	// Notes list and start notes, in notes.ts behind NoteHost -------------------------------------------

	#news?: NewsHost;
	get #newsHost(): NewsHost {
		this.#news ??= {
			graph: this.#graph,
			agents: this.#agents,
			draft: (agent) => this.#draft(agent),
			newerFor: (agent) => this.#newerFor(agent),
			spaceOf: (agent) => this.#spaceOf(agent),
			setOf: (space) => this.#setOf(space),
			viewAt: (space, version) => this.#viewAt(space, version),
			origin: (atom, spaceName) => this.#origin(atom, spaceName),
			collision: (agent, pair) => this.#collision(agent, pair),
			definitionCollisions: (agent, newer) => this.#definitionCollisions(agent, newer),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
		};
		return this.#news;
	}

	#collisions?: CollisionHost;
	get #collisionHost(): CollisionHost {
		this.#collisions ??= {
			graph: this.#graph,
			spaces: this.#spaces,
			version: () => this.version,
			spaceOf: (agent) => this.#spaceOf(agent),
			agentSet: (agent) => unionOverlay(this.#at(this.#spaceOf(agent), agent.base), agent.mine),
			draft: (agent) => this.#draft(agent),
			agentView: (agent) => this.#agentView(agent),
			at: (space, version) => this.#at(space, version),
			shared: () => this.#shared,
		};
		return this.#collisions;
	}

	#markers?: MarkerHost;
	get #markerHost(): MarkerHost {
		this.#markers ??= {
			graph: this.#graph,
			agentView: (agent) => this.#agentView(agent),
			draft: (agent) => this.#draft(agent),
			draftFiles: (agent) => this.#draftFiles(agent),
		};
		return this.#markers;
	}

	#noteWrites?: NoteWriteHost;
	get #noteWriteHost(): NoteWriteHost {
		this.#noteWrites ??= {
			notes: this.#notes,
			agents: this.#agents,
			changes: this.#changes,
			graph: this.#graph,
			lastNote: () => this.#lastNote,
			agentView: (agent) => this.#agentView(agent),
			viewAtVersion: (version) => this.viewAt(version),
			sharedView: () => this.#sharedView(),
			changeOfLines: (lines) => this.#changeOfLines(lines),
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
			noteAnswer: (n) => this.#noteAnswer(n),
		};
		return this.#noteWrites;
	}

	#noteHost?: NoteHost;
	get #notesHost(): NoteHost {
		this.#noteHost ??= {
			graph: this.#graph,
			agents: this.#agents,
			spaces: this.#spaces,
			notes: this.#notes,
			initialized: () => this.initialized,
			shared: () => this.#shared,
			sharedView: () => this.#sharedView(),
			spellingIn: (view, path) => this.spellingIn(view, path),
			viewAt: (space, version) => this.#viewAt(space, version),
			agentView: (agent) => this.#agentView(agent),
			view: (set) => this.#view(set),
			at: (space, version) => this.#at(space, version),
			liveNote: (agent) => this.#liveNote(agent),
		};
		return this.#noteHost;
	}

	#merges?: MergeHost;
	get #mergeHost(): MergeHost {
		this.#merges ??= {
			graph: this.#graph,
			openPairs: (agent) => this.#openPairs(agent),
			draft: (agent) => this.#unqueuedDraft(agent),
			origin: (atom, spaceName) => this.#origin(atom, spaceName),
			view: (set) => this.#view(set),
			viewAt: (space, version) => this.#viewAt(space, version),
			spaceOf: (agent) => this.#spaceOf(agent),
			apply: (entry) => this.#apply(entry),
			agentView: (agent) => this.#agentView(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
		};
		return this.#merges;
	}

	#edits?: EditHost;
	get #editHost(): EditHost {
		this.#edits ??= {
			agents: this.#agents,
			whole: this.#whole,
			initialized: () => this.initialized,
			agentView: (agent) => this.#agentView(agent),
			sharedView: () => this.#sharedView(),
			isWhole: (path, length, view, rules) => this.#isWhole(path, length, view, rules),
			wholeRules: (config) => this.#wholeRules(config),
			record: (agentName, files, time, modes, blobs, meta) => this.record(agentName, files, time, modes, blobs, meta),
			agent: (name, entries) => this.#agent(name, entries),
			draftFiles: (agent) => this.#draftFiles(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			addDraft: (agent, view, input, time, meta, entries) => this.#addDraft(agent, view, input, time, meta, entries),
			overlapNews: (agent, before, entries) => this.#overlapNews(agent, before, entries),
			markedNews: (agent, files, entries) => this.#markedNews(agent, files, entries),
			newsAboutOwnDraft: (agent, entries) => this.#newsAboutOwnDraft(agent, entries),
			takeNews: (agent, entries) => this.#takeNews(agent, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#edits;
	}

	#announces?: AnnounceHost;
	get #announceHost(): AnnounceHost {
		this.#announces ??= {
			agents: this.#agents,
			announced: () => this.#announced,
			setAnnounced: (n) => {
				this.#announced = n;
			},
			agent: (name, entries) => this.#agent(name, entries),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
			needInit: () => this.#needInit(),
		};
		return this.#announces;
	}

	#publishers?: PublishHost;
	get #publishHost(): PublishHost {
		this.#publishers ??= {
			agents: this.#agents,
			nextAt: () => this.#nextAt,
			checkClash: (changes, ahead) => this.#checkClash(changes, ahead),
			queueOn: () => this.#queueOn(),
			queuedAtoms: (except) => this.#queuedAtoms(except),
			agent: (name, entries) => this.#agent(name, entries),
			draft: (agent) => this.#draft(agent),
			spaceOf: (agent) => this.#spaceOf(agent),
			strandedFiles: (draft, set) => this.#strandedFiles(draft, set),
			setOf: (space) => this.#setOf(space),
			markedFiles: (agent) => this.#markedFiles(agent),
			agentView: (agent) => this.#agentView(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			expressMoves: (agent, time, entries) => this.#expressMoves(agent, time, entries),
			pairs: (draft, against, settled) => this.#pairs(draft, against, settled),
			collision: (agent, pair) => this.#collision(agent, pair),
			definitionCollisions: (agent, newer) => this.#definitionCollisions(agent, newer),
			duplicates: (agent) => this.#duplicates(agent),
			refuse: (agent, space, via, time, collisions, entries, message) =>
				this.#refuse(agent, space, via, time, collisions, entries, message),
			markerCollisions: (agent) => this.#markerCollisions(agent),
			enqueue: (agent, message, time, draft, resolves, entries) =>
				this.#enqueue(agent, message, time, draft, resolves, entries),
			view: (set) => this.#view(set),
			requireClosed: (tie, union) => this.#requireClosed(tie, union),
			spaceOverlay: (space, atoms) =>
				this.#viewKeyed(`a ${space.name}@${last(space)}+${atoms.join(",")}`, () =>
					unionOverlay(this.#setOf(space), atoms),
				),
			newerFor: (agent) => this.#newerFor(agent),
			currentChange: (agent, time) => this.#currentChange(agent, time),
			apply: (entry) => this.#apply(entry),
			newsForOthers: (publisher, space, version, entries) => this.#newsForOthers(publisher, space, version, entries),
			settledNews: (agent, version, settled, entries) => this.#settledNews(agent, version, settled, entries),
			addressedNews: (agent, version, entries) => this.#addressedNews(agent, version, entries),
			reviewNews: (agent, version, entries) => this.#reviewNews(agent, version, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#publishers;
	}

	#queues?: QueueHost;
	get #queueHost(): QueueHost {
		this.#queues ??= {
			graph: this.#graph,
			checkerReady: () => this.checkerReady,
			sharedView: () => this.#sharedView(),
			queued: () => this.#queue,
			queuedId: () => this.#queuedId,
			checkingHas: (id) => this.#checking.has(id),
			replaceChecking: (ids) => {
				this.#checking = new Set(ids);
			},
			uncheck: (id) => {
				this.#checking.delete(id);
			},
			needInit: () => this.#needInit(),
			shared: () => this.#shared,
			setOf: (space) => this.#setOf(space),
			view: (set) => this.#view(set),
			agentSet: (agent) => this.#agentSet(agent),
			agentView: (agent) => this.#agentView(agent),
			pairs: (draft, against, settled) => this.#pairs(draft, against, settled),
			describe: (pair, yoursView, theirsView, spaceName) => this.#describe(pair, yoursView, theirsView, spaceName),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
			refuse: (agent, space, via, time, collisions, entries, message) =>
				this.#refuse(agent, space, via, time, collisions, entries, message),
			currentChange: (agent, time) => this.#currentChange(agent, time),
			nextAt: () => this.#nextAt,
			apply: (entry) => this.#apply(entry),
			agentOf: (name) => this.#agentOf(name),
			requireClosed: (tie, union) => this.#requireClosed(tie, union),
			newsForOthers: (publisher, space, version, entries) => this.#newsForOthers(publisher, space, version, entries),
			settledNews: (agent, version, settled, entries) => this.#settledNews(agent, version, settled, entries),
			addressedNews: (agent, version, entries) => this.#addressedNews(agent, version, entries),
			reviewNews: (agent, version, entries) => this.#reviewNews(agent, version, entries),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#queues;
	}

	#applyEntries?: ApplyEntryHost;
	get #applyEntryHost(): ApplyEntryHost {
		this.#applyEntries ??= {
			graph: this.#graph,
			agents: this.#agents,
			atomAt: this.#atomAt,
			mods: this.#mods,
			notes: this.#notes,
			changes: this.#changes,
			labels: this.#labels,
			refusals: this.#refusals,
			tells: this.#tells,
			uncheck: (id) => {
				this.#checking.delete(id);
			},
			stamp: (t) => {
				if (typeof t === "number" && t > this.#lastTime) this.#lastTime = t;
			},
			applyMembership: (entry, at) => this.#membership.apply(entry, at),
			agentOf: (name) => this.#agentOf(name),
			active: (agent, time) => this.#active(agent, time),
			joinChange: (agent, entry, at, draft, landed) => this.#joinChange(agent, entry, at, draft, landed),
			space: (name) => this.#spaces.get(name)!,
			queued: () => this.#queue,
			setQueued: (items) => {
				this.#queue = items;
			},
			setQueuedId: (id) => {
				this.#queuedId = id;
			},
			queuedId: () => this.#queuedId,
			setLastNote: (id) => {
				this.#lastNote = id;
			},
			lastNote: () => this.#lastNote,
			setAnnounced: (n) => {
				this.#announced = n;
			},
			announced: () => this.#announced,
			at: (space, version) => this.#at(space, version),
			spaceOf: (agent) => this.#spaceOf(agent),
			draft: (agent) => this.#draft(agent),
			currentChange: (agent, time) => this.#currentChange(agent, time),
			changeRecord: (id, agent, time) => this.#changeRecord(id, agent, time),
		};
		return this.#applyEntries;
	}

	#landers?: LandHost;
	get #landHost(): LandHost {
		this.#landers ??= {
			viewAt: (space, version, changes) =>
				changes?.length
					? this.#viewKeyed(`a ${space.name}@${version}+${changes.join(",")}`, () =>
							unionOverlay(this.#at(space, version), changes),
						)
					: this.#viewAt(space, version),
			agents: this.#agents,
			graph: this.#graph,
			spaces: this.#spaces,
			version: () => this.version,
			nextAt: () => this.#nextAt,
			notQueuedYet: (what) => this.#notQueuedYet(what),
			checkClash: (changes) => this.#checkClash(changes),
			agent: (name, entries) => this.#agent(name, entries),
			namedSpaceOf: (agent) => this.#namedSpaceOf(agent),
			shared: () => this.#shared,
			setOf: (space) => this.#setOf(space),
			at: (space, version) => this.#at(space, version),
			view: (set) => this.#view(set),
			sharedView: () => this.#sharedView(),
			pairs: (draft, against, settled) => this.#pairs(draft, against, settled),
			describe: (pair, yoursView, theirsView, spaceName) => this.#describe(pair, yoursView, theirsView, spaceName),
			definitionRule: () => this.#definitionRule,
			refuse: (agent, space, via, time, collisions, entries) =>
				this.#refuse(agent, space, via, time, collisions, entries),
			requireClosed: (tie, union) => this.#requireClosed(tie, union),
			apply: (entry) => this.#apply(entry),
			newsForOthers: (publisher, space, version, entries) => this.#newsForOthers(publisher, space, version, entries),
			addressedNews: (agent, version, entries) => this.#addressedNews(agent, version, entries),
			reviewNews: (agent, version, entries) => this.#reviewNews(agent, version, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#landers;
	}

	#records?: RecordHost;
	get #recordHost(): RecordHost {
		this.#records ??= {
			agents: this.#agents,
			whole: this.#whole,
			initialized: () => this.initialized,
			agentView: (agent) => this.#agentView(agent),
			sharedView: () => this.#sharedView(),
			wholeOut: (files, blobs, view, config) => this.#wholeOut(files, blobs, view, config),
			checkBlobs: (blobs, files) => this.#checkBlobs(blobs, files),
			agent: (name, entries) => this.#agent(name, entries),
			draftFiles: (agent) => this.#draftFiles(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			overlapNews: (agent, before, entries) => this.#overlapNews(agent, before, entries),
			markedNews: (agent, files, entries) => this.#markedNews(agent, files, entries),
			newsAboutOwnDraft: (agent, entries) => this.#newsAboutOwnDraft(agent, entries),
			takeNews: (agent, entries) => this.#takeNews(agent, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#records;
	}

	#restores?: RestoreHost;
	get #restoreHost(): RestoreHost {
		this.#restores ??= {
			graph: this.#graph,
			agent: (name, entries) => this.#agent(name, entries),
			draft: (agent) => this.#unqueuedDraft(agent),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
			apply: (entry) => this.#apply(entry),
			view: (set) => this.#view(set),
			agentSet: (agent) => this.#agentSet(agent),
			agentView: (agent) => this.#agentView(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			flush: (entries) => this.#flush(entries),
		};
		return this.#restores;
	}

	#startings?: StartingHost;
	get #startingHost(): StartingHost {
		this.#startings ??= {
			agents: this.#agents,
			changes: this.#changes,
			agent: (name, entries) => this.#agent(name, entries),
			liveNote: (agent) => this.#liveNote(agent),
			apply: (entry) => this.#apply(entry),
			overlaps: (agent, patterns) => this.#overlaps(agent, patterns),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#startings;
	}

	#syncs?: SyncHost;
	get #syncHost(): SyncHost {
		this.#syncs ??= {
			graph: this.#graph,
			labels: this.#labels,
			agent: (name, entries) => this.#agent(name, entries),
			spaceOf: (agent) => this.#spaceOf(agent),
			agentView: (agent) => this.#agentView(agent),
			at: (space, version) => this.#at(space, version),
			draft: (agent) => this.#draft(agent),
			strandedFiles: (draft, set) => this.#strandedFiles(draft, set),
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
			mergeIdentical: (agent, before, oldBase, oldVersion, time, entries) =>
				this.#mergeIdentical(agent, before, oldBase, oldVersion, time, entries),
			changesSince: (agent, before) => this.#changesSince(agent, before),
		};
		return this.#syncs;
	}

	#moves?: MoveHost;
	get #moveHost(): MoveHost {
		this.#moves ??= {
			needInit: () => this.#needInit(),
			agents: this.#agents,
			agentView: (agent) => this.#agentView(agent),
			sharedView: () => this.#sharedView(),
			agent: (name, entries) => this.#agent(name, entries),
			addDraft: (agent, view, input, time, meta, entries) => this.#addDraft(agent, view, input, time, meta, entries),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			newsAboutOwnDraft: (agent, entries) => this.#newsAboutOwnDraft(agent, entries),
			takeNews: (agent, entries) => this.#takeNews(agent, entries),
			flush: (entries) => this.#flush(entries),
		};
		return this.#moves;
	}

	#switches?: SwitchHost;
	get #switchHost(): SwitchHost {
		this.#switches ??= {
			agent: (name, entries) => this.#agent(name, entries),
			flush: (entries) => this.#flush(entries),
			spaces: this.#spaces,
			agentView: (agent) => this.#agentView(agent),
			graph: this.#graph,
			version: () => this.version,
			apply: (entry) => this.#apply(entry),
			draft: (agent) => this.#draft(agent),
			setOf: (space) => this.#setOf(space),
			changesSince: (agent, before) => this.#changesSince(agent, before),
		};
		return this.#switches;
	}

	#draftStates?: DraftStateHost;
	get #draftStateHost(): DraftStateHost {
		this.#draftStates ??= {
			needInit: () => this.#needInit(),
			spaceNamed: (name) => this.#spaceNamed(name),
			shared: () => this.#shared,
			graph: this.#graph,
			agents: this.#agents,
			draft: (agent) => this.#draft(agent),
			checkClash: (changes) => this.#checkClash(changes),
			landCollisions: (space, changes, pick) => this.#landCollisions(space, changes, pick),
		};
		return this.#draftStates;
	}

	#checkClashes?: CheckClashHost;
	get #checkClashHost(): CheckClashHost {
		this.#checkClashes ??= {
			shared: () => this.#shared,
			setOf: (space) => this.#setOf(space),
			view: (set) => this.#view(set),
			sharedView: () => this.#sharedView(),
			sharedOverlay: (atoms) =>
				this.#viewKeyed(`a @${last(this.#shared)}+${atoms.join(",")}`, () =>
					unionOverlay(this.#setOf(this.#shared), atoms),
				),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
		};
		return this.#checkClashes;
	}

	#changesSinces?: ChangesSinceHost;
	get #changesSinceHost(): ChangesSinceHost {
		this.#changesSinces ??= {
			agentView: (agent) => this.#agentView(agent),
			touchedFiles: (ids, views) => this.#touchedFiles(ids, views),
			openPairs: (agent) => this.#openPairs(agent),
			collision: (agent, pair) => this.#collision(agent, pair),
			duplicates: (agent) => this.#duplicates(agent),
			markedCollisions: (agent) => this.#markedCollisions(agent),
		};
		return this.#changesSinces;
	}

	#inits?: InitHost;
	get #initHost(): InitHost {
		this.#inits ??= {
			initialized: () => this.initialized,
			whole: this.#whole,
			wholeOut: (files, blobs, view, config) => this.#wholeOut(files, blobs, view, config),
			checkBlobs: (blobs, files) => this.#checkBlobs(blobs, files),
			commit: (entries) => this.#commit(entries),
		};
		return this.#inits;
	}

	#amends?: AmendHost;
	get #amendHost(): AmendHost {
		this.#amends ??= {
			agent: (name, entries) => this.#agent(name, entries),
			spaceOf: (agent) => this.#spaceOf(agent),
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
		};
		return this.#amends;
	}

	#labelHosts?: LabelHost;
	get #labelHost(): LabelHost {
		this.#labelHosts ??= {
			agent: (name, entries) => this.#agent(name, entries),
			version: () => this.version,
			labels: this.#labels,
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
		};
		return this.#labelHosts;
	}

	#publishOfs?: PublishOfHost;
	get #publishOfHost(): PublishOfHost {
		this.#publishOfs ??= {
			shared: () => this.#shared,
			spaces: this.#spaces,
		};
		return this.#publishOfs;
	}

	#versionMetas?: VersionMetaHost;
	get #versionMetaHost(): VersionMetaHost {
		this.#versionMetas ??= {
			needInit: () => this.#needInit(),
			spaceNamed: (name) => this.#spaceNamed(name),
		};
		return this.#versionMetas;
	}

	#refuses?: RefuseHost;
	get #refuseHost(): RefuseHost {
		this.#refuses ??= {
			apply: (entry) => this.#apply(entry),
			refusals: this.#refusals,
		};
		return this.#refuses;
	}

	#overlapsHost?: OverlapHost;
	get #overlapHost(): OverlapHost {
		this.#overlapsHost ??= {
			graph: this.#graph,
			agents: this.#agents,
			agentView: (agent) => this.#agentView(agent),
			draft: (agent) => this.#draft(agent),
			draftFiles: (agent) => this.#draftFiles(agent),
			liveNote: (agent) => this.#liveNote(agent),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
		};
		return this.#overlapsHost;
	}

	#recordFiles?: RecordFileHost;
	get #recordFileHost(): RecordFileHost {
		this.#recordFiles ??= {
			addDraft: (agent, view, input, time, meta, entries) => this.#addDraft(agent, view, input, time, meta, entries),
		};
		return this.#recordFiles;
	}

	#addDrafts?: AddDraftHost;
	get #addDraftHost(): AddDraftHost {
		this.#addDrafts ??= {
			graph: this.#graph,
			openPairs: (agent) => this.#openPairs(agent),
			markersSettled: (agent, view, atom) => this.#markersSettled(agent, view, atom),
			apply: (entry) => this.#apply(entry),
		};
		return this.#addDrafts;
	}

	#ingests?: IngestHost;
	get #ingestHost(): IngestHost {
		this.#ingests ??= {
			agents: this.#agents,
			spaces: this.#spaces,
			needInit: () => this.#needInit(),
			version: () => this.version,
			checkBlobs: (blobs, files) => this.#checkBlobs(blobs, files),
			apply: (entry) => this.#apply(entry),
			flush: (entries) => this.#flush(entries),
			wholeOut: (files, blobs, view, config) => this.#wholeOut(files, blobs, view, config),
			agentView: (agent) => this.#agentView(agent),
			recordFile: (agent, view, path, text, time, meta, entries, mode, blob, hunks) =>
				this.#recordFile(agent, view, path, text, time, meta, entries, mode, blob, hunks),
			publish: (agent, message, time, entries, asIs, direct) =>
				this.#publish(agent, message, time, entries, asIs, direct),
			land: (agent, message, time, entries, pick) => this.#land(agent, message, time, entries, pick),
		};
		return this.#ingests;
	}

	#plucks?: PluckHost;
	get #pluckHost(): PluckHost {
		this.#plucks ??= {
			graph: this.#graph,
			spaces: this.#spaces,
			agent: (name, entries) => this.#agent(name, entries),
			shared: () => this.#shared,
			notQueuedYet: (what) => this.#notQueuedYet(what),
			strandedFiles: (draft, set) => this.#strandedFiles(draft, set),
			checkClash: (changes) => this.#checkClash(changes),
			land: (agent, message, time, entries, pick) => this.#land(agent, message, time, entries, pick),
			flush: (entries) => this.#flush(entries),
		};
		return this.#plucks;
	}

	#drops?: DropHost;
	get #dropHost(): DropHost {
		this.#drops ??= {
			graph: this.#graph,
			agents: this.#agents,
			spaces: this.#spaces,
			agent: (name, entries) => this.#agent(name, entries),
			shared: () => this.#shared,
			flush: (entries) => this.#flush(entries),
			apply: (entry) => this.#apply(entry),
			queueNews: (agent, items, entries) => this.#queueNews(agent, items, entries),
			addressedNews: (agent, version, entries) => this.#addressedNews(agent, version, entries),
		};
		return this.#drops;
	}

	// Changes (#44), in change-records.ts behind ChangeHost ---------------------------------------------

	#changeRecords?: ChangeHost;
	get #changeHost(): ChangeHost {
		this.#changeRecords ??= {
			changes: this.#changes,
			agents: this.#agents,
			spaces: this.#spaces,
			notes: this.#notes,
			versionChange: this.#versionChange,
			paths: this.#paths,
			graph: this.#graph,
			stored: () => this.#stored,
			shared: () => this.#shared,
			queue: () => this.#queue,
			active: (agent, time) => this.#active(agent, time),
			currentChange: (agent, time) => this.#currentChange(agent, time),
			liveNote: (agent) => this.#liveNote(agent),
			noteAnswer: (n) => this.#noteAnswer(n),
			reviewersOf: (files, id) => this.#reviewersOf(files, id),
		};
		return this.#changeRecords;
	}

	// What the project looks like now, in project-status.ts behind SnapshotHost -------------------------

	#snapshotHost?: SnapshotHost;
	get #snapshot(): SnapshotHost {
		this.#snapshotHost ??= {
			agents: this.#agents,
			spaces: this.#spaces,
			queue: () => this.#queue,
			refusals: this.#refusals,
			labels: this.#labels,
			tells: this.#tells,
			needInit: () => this.#needInit(),
			shared: () => this.#shared,
			draft: (agent) => this.#draft(agent),
			draftFiles: (agent) => this.#draftFiles(agent),
			liveNote: (agent) => this.#liveNote(agent),
			openCollisions: (agent) => this.#openCollisions(agent),
			editsOf: (agent) => this.#editsOf(agent),
			setOf: (space) => this.#setOf(space),
			spaceNamed: (name) => this.#spaceNamed(name),
			checkVersion: (space, version) => this.#checkVersion(space, version),
			viewAt: (space, version) => this.#viewAt(space, version),
			agentView: (agent) => this.#agentView(agent),
			version: () => this.version,
			projectFile: () => (this.initialized ? projectFileIn(this.#sharedView()) : undefined),
		};
		return this.#snapshotHost;
	}

	/** The paths in an agent's view now (project-status.ts). */
	agentPaths(...args: Tail<Parameters<typeof snapshotAgentPaths>>): ReturnType<typeof snapshotAgentPaths> {
		return snapshotAgentPaths(this.#snapshot, ...args);
	}

	/** The paths in shared, or a named draft, at a version (project-status.ts). */
	pathsAt(...args: Tail<Parameters<typeof snapshotPathsAt>>): ReturnType<typeof snapshotPathsAt> {
		return snapshotPathsAt(this.#snapshot, ...args);
	}

	/** The paths in an agent's view now, for a reader (project-status.ts). */
	pathsOf(...args: Tail<Parameters<typeof snapshotPathsOf>>): ReturnType<typeof snapshotPathsOf> {
		return snapshotPathsOf(this.#snapshot, ...args);
	}

	/** Every label, with the versions it marks, newest first (project-status.ts). */
	labels(): ReturnType<typeof snapshotLabels> {
		return snapshotLabels(this.#snapshot);
	}

	/** Agents, drafts, refusals and waiting announcements (project-status.ts). */
	status(): ReturnType<typeof snapshotStatus> {
		return snapshotStatus(this.#snapshot);
	}

	/** The operation fence needs one actor's heads, not every agent's file projection. */
	actorHead(name: string): { base: number; draftChanges: number; draft: string | null } | undefined {
		const agent = this.#agents.get(name);
		if (!agent) return undefined;
		const published = this.#setOf(this.#spaceOf(agent));
		let draftChanges = 0;
		for (const id of agent.mine) if (!published.has(id)) draftChanges++;
		return { base: agent.base, draftChanges, draft: agent.space === SHARED ? null : agent.space };
	}

	/** A space's contents at one of its versions. */
	#at(space: Space, version: number): ReadonlySet<AtomId> {
		return this.#membership.at(space, version);
	}

	/** A space's contents now. */
	#setOf(space: Space): ReadonlySet<AtomId> {
		return this.#at(space, last(space));
	}

	#draft(agent: AgentState): AtomId[] {
		const set = this.#setOf(this.#spaceOf(agent));
		return agent.mine.filter((id) => !set.has(id));
	}

	/**
	 * The draft without the agent's publishes waiting in the queue (#39): what
	 * moves, restore and sync's merge may drop and make again. A queued item's
	 * atoms are no longer the draft's to remake; dropping them let the queue
	 * land a tie that depends on discarded atoms (abso issue 135, item 4).
	 * Undoing a queued publish is abso unqueue.
	 */
	#unqueuedDraft(agent: AgentState): AtomId[] {
		const draft = this.#draft(agent);
		const held = this.#queuedAtoms();
		return held.size === 0 ? draft : draft.filter((id) => !held.has(id));
	}

	#agentSet(agent: AgentState): Set<AtomId> {
		return new Set([...this.#at(this.#spaceOf(agent), agent.base), ...agent.mine]);
	}

	#agentView(agent: AgentState): ReadView {
		return this.#viewKeyed(this.#agentViewKey(agent), () => {
			const base = this.#at(this.#spaceOf(agent), agent.base);
			return base instanceof StableSet
				? new StableUnionSet(base, new StableOverlaySet(agent.mine))
				: new Set([...base, ...agent.mine]);
		});
	}

	/** An agent's view, keyed by what the set is made of, not by sorting every atom in it (#46): that cost more than the work. */
	#agentViewKey(agent: AgentState): string {
		// An empty draft is exactly its published base. Share its projection
		// with version readers instead of walking the same history twice.
		if (agent.mine.length === 0) return `v ${agent.space}@${agent.base}`;
		return `a ${agent.space}@${agent.base}+${agent.mine.join(",")}`;
	}

	/** A space at a version: published versions never change, so the key is just their names (#46). */
	#viewAt(space: Space, version: number): ReadView {
		return this.#viewKeyed(`v ${space.name}@${version}`, () => this.#at(space, version));
	}

	#sharedView(): ReadView {
		return this.#viewAt(this.#shared, last(this.#shared));
	}

	/** A view of a set, cached by the set's exact contents (views.ts). */
	#view(set: ReadonlySet<AtomId>): ReadView {
		this.#views.assertUnkeyedAllowed();
		return this.#views.view(this.#closed(set));
	}

	/** A view cached under `key` (views.ts). */
	#viewKeyed(key: string, set: () => ReadonlySet<AtomId>): ReadView {
		return this.#views.keyed(key, () => this.#closed(set()));
	}

	/**
	 * A discarded atom that a later publish still depends on stays in the view
	 * (abso issue 80). A closed set is unchanged.
	 */
	#closed(set: Iterable<AtomId>): ReadonlySet<AtomId> {
		if (set instanceof StableSet) {
			// Keep indexed membership external. Only dependencies absent from
			// that snapshot belong in the operation's closure overlay.
			const missing = new Set<AtomId>();
			const visit = (id: AtomId) => {
				const stack = [id];
				while (stack.length) {
					for (const dependency of this.#graph.atom(stack.pop()!).deps) {
						if (!set.has(dependency) && !missing.has(dependency)) {
							missing.add(dependency);
							stack.push(dependency);
						}
					}
				}
			};
			for (const id of set) visit(id);
			return missing.size ? new StableUnionSet(set, new StableOverlaySet(missing)) : set;
		}
		return this.#graph.closureOf(set);
	}

	/** A new publish or land must not depend on an atom outside the set (abso issue 80). */
	#requireClosed(tie: { deps: readonly AtomId[] }, union: ReadonlySet<AtomId>): void {
		const missing = tie.deps.filter((id) => !union.has(id));
		if (missing.length > 0)
			throw new ProjectError(
				"conflict",
				`this change depends on ${missing.join(", ")}, which is not in the set being pushed`,
			);
	}

	/** The space's atoms published after the agent's base, by others. */
	#newerFor(agent: AgentState): ReadonlySet<AtomId> {
		const space = this.#spaceOf(agent);
		const base = this.#at(space, agent.base);
		const current = this.#setOf(space);
		const newer =
			space.name === SHARED && space.membershipVersion
				? new SharedAdditions(space, agent.base, base, current)
				: differenceSet(current, base);
		return differenceSet(newer, new StableOverlaySet(agent.mine));
	}

	/** The files whose text in the agent's view differs from `before`, and its open collisions. */
	#changesSince(...args: Tail<Parameters<typeof hostedChangesSince>>): ReturnType<typeof hostedChangesSince> {
		return hostedChangesSince(this.#changesSinceHost, ...args);
	}

	/** Who published an atom, looking in the given space first and then in shared. */
	#origin(atom: AtomId, spaceName: string): Origin {
		return originOf(this.#collisionHost, atom, spaceName);
	}

	// Drafting ----------------------------------------------------------------------

	/** Check a {path: sha256} map: hex hashes, no path also given as text, and bytes already uploaded. */
	#checkBlobs(blobs: unknown, files: object): Record<string, string> {
		if (typeof blobs !== "object" || blobs === null || Array.isArray(blobs))
			throw new ProjectError("bad-request", "blobs must be {path: sha256}");
		for (const [path, sha] of Object.entries(blobs as Record<string, unknown>)) {
			checkPath(path);
			if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))
				throw new ProjectError("bad-request", `${path}: a blob is the SHA-256 of the bytes, in lowercase hex`);
			if (Object.hasOwn(files, path)) throw new ProjectError("bad-request", `${path} is given as both text and a blob`);
			if (!this.#hasBlob(sha))
				throw new ProjectError("bad-request", `${path}: upload blob ${sha} first (PUT /p/:project/blobs/${sha})`);
		}
		return blobs as Record<string, string>;
	}

	/**
	 * Make one file in the agent's view what the folder has, as one draft
	 * change: `text` (null: the file is gone; "": an empty file; undefined:
	 * leave its lines alone) and `mode` (only the fields given). Returns
	 * whether anything changed.
	 */
	#recordFile(...args: Tail<Parameters<typeof hostedRecordFile>>): ReturnType<typeof hostedRecordFile> {
		return hostedRecordFile(this.#recordFileHost, ...args);
	}

	/**
	 * Moves (#28). Within one agent's unpublished draft, a line that leaves one
	 * place and the same text that arrives somewhere else is the same line, in
	 * either order (deleted then written, or written then deleted). Before a
	 * publish, the draft's changes to the files involved are dropped (a discard
	 * entry) and made again: one move per matched block, which keeps the
	 * lines' ids, then a change per file to the draft's final text. The files
	 * end up exactly as the draft had them. A matched block needs a line with
	 * real content: blank lines and lone brackets only travel next to one.
	 */
	#expressMoves(agent: AgentState, time: number, entries: Entry[]): void {
		hostedExpressMoves(this.#expressMovesHost, agent, time, entries);
	}

	/**
	 * Build a draft change against the agent's view. If it touches lines on
	 * either side of a collision the agent has already seen, it settles that
	 * collision (the engine's `resolves`).
	 */
	#addDraft(...args: Tail<Parameters<typeof hostedAddDraft>>): ReturnType<typeof hostedAddDraft> {
		return hostedAddDraft(this.#addDraftHost, ...args);
	}

	// Collisions and news -------------------------------------------------------------

	#pairs(draft: readonly AtomId[], against: ReadonlySet<AtomId>, settled: ReadonlySet<AtomId>): Pair[] {
		return pairsIn(this.#graph, draft, against, settled);
	}

	/**
	 * Collisions the agent has synced into and not settled: its draft against
	 * its space at its base. In a named draft, also the draft's own changes
	 * against shared work the draft was moved onto.
	 */
	#openPairs(agent: AgentState): Pair[] {
		return hostedOpenPairs(this.#collisionHost, agent);
	}

	/** After the agent's own change: news when its draft now collides with work published after its base. */
	#newsAboutOwnDraft(agent: AgentState, entries: Entry[]): void {
		hostedNewsAboutOwnDraft(this.#newsHost, agent, entries);
	}

	/** After a publish or a landing: news for every other agent in that space whose draft collides with what just arrived. */
	#newsForOthers(publisher: AgentState, space: Space, version: number, entries: Entry[]): void {
		hostedNewsForOthers(this.#newsHost, publisher, space, version, entries);
	}

	#queueNews(agent: AgentState, items: readonly { key: string; text: string }[], entries: Entry[]): void {
		const fresh = items.filter((p) => !agent.told.has(p.key));
		if (fresh.length === 0) return;
		const text = [...new Set(fresh.map((p) => p.text))];
		const entry: Entry = { type: "news", agent: agent.name, pairs: [...new Set(fresh.map((p) => p.key))], text };
		entries.push(entry);
		this.#apply(entry);
	}

	#takeNews(agent: AgentState, entries: Entry[]): string[] {
		if (agent.news.length === 0) return [];
		const news = [...agent.news];
		const entry: Entry = { type: "heard", agent: agent.name };
		entries.push(entry);
		this.#apply(entry);
		return news;
	}

	/** Describe a pair for the agent: its side in its own view, theirs in its space now. */
	#collision(agent: AgentState, pair: Pair): Collision {
		return this.#describe(
			pair,
			this.#agentView(agent),
			this.#viewAt(this.#spaceOf(agent), last(this.#spaceOf(agent))),
			agent.space,
		);
	}

	#describe(pair: Pair, yoursView: ReadView, theirsView: ReadView, spaceName: string): Collision {
		return describePair(
			this.#graph,
			(atom, space) => this.#origin(atom, space),
			pair,
			yoursView,
			theirsView,
			spaceName,
		);
	}

	#touchedFiles(ids: Iterable<AtomId>, views: readonly ReadView[]): Set<string> {
		return touchedFiles(this.#graph, ids, views);
	}

	// The changed-definition rule (#11) -------------------------------------------

	/** The rule for an agent's draft in its space. */
	#definitionCollisions(agent: AgentState, newer: ReadonlySet<AtomId>): DefinitionCollision[] {
		const draft = new Set(this.#draft(agent));
		if (draft.size === 0 || newer.size === 0) return [];
		const space = this.#spaceOf(agent);
		const at = this.#at(space, agent.base);
		const base = agent.mine.some((id) => at.has(id))
			? this.#view(differenceSet(at, new StableOverlaySet(agent.mine)))
			: this.#viewAt(space, agent.base);
		return this.#definitionRule.collisions(
			draft,
			this.#agentView(agent),
			base,
			this.#viewAt(space, last(space)),
			newer,
			space.name,
		);
	}
}

export { EngineError };
