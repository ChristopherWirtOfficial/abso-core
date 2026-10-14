import { ProjectionAtomAdoption } from "../../src/engine/experimental/projection-atom-adoption.ts";
import { ProjectionAtomIndex } from "../../src/engine/experimental/projection-atom-index.ts";
import { ExperimentalMarkerProjection, type MarkerState } from "../../src/engine/experimental/projection-marker.ts";
import { ProjectionOverlayStorage } from "../../src/engine/experimental/projection-overlay-storage.ts";
import { ProjectionReadScope } from "../../src/engine/experimental/projection-read-scope.ts";
import {
	assertProjectionIdentity,
	type ProjectionHandle,
	type ProjectionIdentity,
} from "../../src/engine/experimental/projection-root.ts";
import { ProjectionSnapshots } from "../../src/engine/experimental/projection-snapshots.ts";
import { Graph } from "../../src/engine/graph.ts";
import { CachedStateStorage, type GraphStateStorage } from "../../src/engine/state-source.ts";
import { canonicalJson } from "../../worker/project/operation-protocol.ts";
import { projectedReader } from "../../worker/project/projection-provider.ts";
import { Membership, type Published } from "../../worker/project/spaces.ts";
import {
	advanceWriterRoot,
	type SqliteWriterState,
	type WriterProjectionHost,
	type WriterProjectionSession,
	type WriterRoot,
} from "./writer-host.ts";

type Context = Pick<ProjectionIdentity, "database" | "namespace" | "registry" | "defaultFile">;
interface Cursor {
	source: WriterRoot;
	version: number;
	offset: number;
	ordered: boolean;
	state: MarkerState;
	ready: boolean;
}
interface Head {
	version: number;
	handle: ProjectionHandle;
	source: WriterRoot;
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function shape(value: unknown, fields: string): asserts value is Record<string, unknown> {
	const keys = fields.split(" ");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw Error("invalid projection host record");
}
function source(value: unknown): asserts value is WriterRoot {
	shape(value, "format generation logLength sharedVersion digest");
	if (
		value.format !== 1 ||
		!integer(value.generation) ||
		!integer(value.logLength) ||
		!integer(value.sharedVersion) ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.digest)
	)
		throw Error("invalid projection source root");
}

/** Private format experiment. Constructor injection only; production has no selection path. */
export class SqliteProjectionStore implements WriterProjectionHost {
	readonly #context: Context;
	readonly #generation: number;
	readonly #indexedAtoms: boolean;
	readonly #meta: string;
	#active = false;
	#nextOverlay = 0;
	constructor(context: Context, namespaceGeneration: number, options: { indexedAtoms?: boolean } = {}) {
		if (!Number.isSafeInteger(namespaceGeneration) || namespaceGeneration < 0)
			throw Error("invalid projection namespace generation");
		this.#context = Object.freeze({ ...context });
		this.#generation = namespaceGeneration;
		this.#indexedAtoms = options.indexedAtoms ?? false;
		this.#meta = `projection-host:${JSON.stringify(context.namespace)}`;
	}
	#bind(state: SqliteWriterState): void {
		const mode = state.read("host", "projection-atom-index-mode");
		if (this.#indexedAtoms ? mode !== 1 : mode === 1) throw Error("projection atom indexing mode mismatch");
		const expected = {
			...this.#context,
			generation: this.#generation,
			...(this.#indexedAtoms ? { atomIndexFormat: 1 } : {}),
		};
		const found = state.read(this.#meta, "binding");
		if (found !== undefined && canonicalJson(found) !== canonicalJson(expected))
			throw Error("projection namespace identity mismatch");
		if (found === undefined) state.write(this.#meta, "binding", expected);
	}
	#firstPending(state: SqliteWriterState, collection: string): readonly [string, unknown] | undefined {
		const iterator = state.entries(collection)[Symbol.iterator]();
		try {
			const next = iterator.next();
			return next.done ? undefined : next.value;
		} finally {
			iterator.return?.();
		}
	}
	#identity(source: WriterRoot, version: number): ProjectionIdentity {
		return {
			...this.#context,
			sourceGeneration: this.#generation,
			sourceLength: source.logLength,
			sourceDigest: source.digest,
			membership: String(version),
		};
	}
	#cursor(value: unknown): Cursor | undefined {
		if (value === undefined) return undefined;
		shape(value, "source version offset ordered state ready");
		source(value.source);
		if (
			!integer(value.version) ||
			value.version > value.source.sharedVersion + 1 ||
			!integer(value.offset) ||
			typeof value.ordered !== "boolean" ||
			typeof value.ready !== "boolean" ||
			value.ready !== (value.version === value.source.sharedVersion + 1) ||
			(value.ready && (value.offset !== 0 || value.ordered))
		)
			throw Error("invalid projection adoption cursor");
		shape(value.state, "context sequence locator membership children attributeFiles");
		if (value.state.context !== JSON.stringify([this.#context.namespace, this.#context.defaultFile]))
			throw Error("projection adoption context mismatch");
		for (const key of ["locator", "membership", "children", "attributeFiles"])
			if (value.state[key] !== null && !integer(value.state[key])) throw Error("invalid adoption page reference");
		shape(value.state.sequence, "map root next");
		const seq = value.state.sequence;
		if (
			!integer(seq.next) ||
			seq.next > 2 ** 32 ||
			(seq.map !== null && !integer(seq.map)) ||
			(seq.root !== null && (!integer(seq.root) || seq.root >= seq.next)) ||
			(seq.root === null) !== (seq.next === 0) ||
			(seq.map === null) !== (seq.root === null)
		)
			throw Error("invalid adoption sequence state");
		return value as unknown as Cursor;
	}
	#head(value: unknown, expected: WriterRoot): Head | undefined {
		if (value === undefined) return undefined;
		shape(value, "version handle source");
		source(value.source);
		if (
			!integer(value.version) ||
			value.version !== expected.sharedVersion ||
			canonicalJson(value.source) !== canonicalJson(expected)
		)
			throw Error("projection head is stale");
		shape(value.handle, "format id identity");
		if (value.handle.format !== 1 || !integer(value.handle.id)) throw Error("invalid projection head handle");
		assertProjectionIdentity(value.handle.identity as ProjectionIdentity, this.#identity(expected, value.version));
		return value as unknown as Head;
	}
	#save(
		state: SqliteWriterState,
		snapshots: ProjectionSnapshots,
		value: MarkerState,
		source: WriterRoot,
		version: number,
	): ProjectionHandle {
		const stored = state.read(this.#meta, "next-root");
		const next = stored === undefined ? 0 : stored;
		if (!integer(next) || !Number.isSafeInteger(next + 1)) throw Error("invalid projection root allocation");
		const handle = snapshots.save(next, this.#identity(source, version), value);
		state.write(this.#meta, "next-root", next + 1);
		state.write(`${this.#meta}:versions`, String(version), handle);
		state.write(`${this.#meta}:prefixes`, String(source.logLength), source.digest);
		state.write(this.#meta, "head", { version, handle, source } satisfies Head);
		return handle;
	}
	#atoms(graph: Graph, delta: Published): { id: string; remove: boolean }[] {
		return [
			...[...(delta.dropped ?? [])]
				.sort((a, b) => graph.atom(b).seq - graph.atom(a).seq)
				.map((id) => ({ id, remove: true })),
			...[...delta.atoms].sort((a, b) => graph.atom(a).seq - graph.atom(b).seq).map((id) => ({ id, remove: false })),
		];
	}
	/** Each page is bounded in atoms and completed versions; the writer root is rechecked before commit. */
	adopt(input: {
		state: SqliteWriterState;
		expected: WriterRoot;
		currentRoot(): WriterRoot;
		maxAtoms: number;
		maxVersions: number;
		maxSteps?: number;
	}): { ready: boolean; version: number; applied: number; prepared: number; steps: number; atomicMoveWork: boolean } {
		if (this.#active) throw Error("projection writer is active");
		source(input.expected);
		const maxSteps = input.maxSteps ?? 64;
		if (![input.maxAtoms, input.maxVersions, maxSteps].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 256))
			throw Error("invalid projection adoption bounds");
		return input.state.transaction(() => {
			const check = () => {
				if (canonicalJson(input.currentRoot()) !== canonicalJson(input.expected))
					throw Error("projection adoption source changed");
			};
			check();
			this.#bind(input.state);
			// One bounded cache per adoption page; no cache survives a return or rollback.
			const pageStorage = new CachedStateStorage(input.state, 262_144, 2048);
			const graph = new Graph({ storage: pageStorage });
			const atomIndex = this.#indexedAtoms ? new ProjectionAtomIndex(pageStorage) : undefined;
			const atomSeq = (id: string) => {
				if (!graph.has(id)) throw Error("missing projection atom");
				return Number(id.slice(1));
			};
			const adapter = new ExperimentalMarkerProjection(
				pageStorage,
				graph,
				this.#context.defaultFile,
				this.#context.namespace,
			);
			const snapshots = new ProjectionSnapshots(pageStorage, adapter, this.#context);
			const versions = new Membership(pageStorage).shared.versions;
			let cursor = this.#cursor(input.state.read(this.#meta, "adoption"));
			if (cursor && canonicalJson(cursor.source) !== canonicalJson(input.expected))
				throw Error("projection adoption cursor changed");
			cursor ??= {
				source: input.expected,
				version: 0,
				offset: 0,
				ordered: false,
				state: adapter.empty(),
				ready: false,
			};
			let applied = 0,
				prepared = 0,
				completed = 0,
				steps = 0,
				atomicMoveWork = false;
			const pending = `${this.#meta}:adoption-order`;
			while (
				!cursor.ready &&
				applied + prepared < input.maxAtoms &&
				completed < input.maxVersions &&
				steps < maxSteps
			) {
				const delta = versions[cursor.version];
				if (!delta || delta.version !== cursor.version) throw Error("missing projection adoption version");
				const drops = delta.dropped ?? [];
				const count = drops.length + delta.atoms.length;
				if (cursor.offset > count || (cursor.ordered && cursor.offset !== count))
					throw Error("invalid projection adoption offset");
				while (!cursor.ordered && cursor.offset < count && applied + prepared < input.maxAtoms) {
					const remove = cursor.offset < drops.length;
					const id = remove ? drops[cursor.offset]! : delta.atoms[cursor.offset - drops.length]!;
					const seq = atomSeq(id);
					if (!Number.isSafeInteger(seq) || seq < 0) throw Error("invalid adoption atom sequence");
					const rank = remove ? Number.MAX_SAFE_INTEGER - seq : seq;
					const key = `${remove ? "0" : "1"}:${rank.toString(16).padStart(14, "0")}`;
					input.state.write(pending, key, { id, remove, version: cursor.version, index: cursor.offset });
					cursor.offset++;
					prepared++;
				}
				if (cursor.offset === count) cursor.ordered = true;
				if (!cursor.ordered) break;
				while (applied + prepared < input.maxAtoms && steps < maxSteps) {
					const next = this.#firstPending(input.state, pending);
					if (!next) break;
					const [key, value] = next;
					shape(value, "id remove version index");
					if (
						typeof value.id !== "string" ||
						!value.id.length ||
						value.id.length > 4096 ||
						typeof value.remove !== "boolean" ||
						value.version !== cursor.version ||
						!integer(value.index) ||
						value.index >= count ||
						value.remove !== value.index < drops.length ||
						value.id !== (value.remove ? drops[value.index] : delta.atoms[value.index - drops.length])
					)
						throw Error("invalid projection pending atom");
					const item = value as { id: string; remove: boolean };
					const seq = atomSeq(item.id);
					const rank = item.remove ? Number.MAX_SAFE_INTEGER - seq : seq;
					if (key !== `${item.remove ? "0" : "1"}:${rank.toString(16).padStart(14, "0")}`)
						throw Error("projection pending order mismatch");
					const task = `${cursor.version}:${key}`;
					const page = new ProjectionAtomAdoption(adapter, task).page({
						previous: cursor.state,
						atom: atomIndex ? atomIndex.openAccepted(item.id) : graph.atom(item.id),
						remove: item.remove,
						source: input.expected.digest,
						maxSteps: maxSteps - steps,
						validateSource: check,
					});
					steps += page.steps;
					atomicMoveWork ||= page.atomicMoveWork;
					if (!page.done) break;
					cursor.state = page.state;
					adapter.storage.remove(`atom-adoption:${task}`, "cursor");
					input.state.remove(pending, key);
					applied++;
				}
				if (!this.#firstPending(input.state, pending)) {
					this.#save(input.state, snapshots, cursor.state, input.expected, cursor.version);
					cursor.version++;
					cursor.offset = 0;
					cursor.ordered = false;
					completed++;
					cursor.ready = cursor.version > input.expected.sharedVersion;
				}
			}
			check();
			input.state.write(this.#meta, "adoption", cursor);
			return { ready: cursor.ready, version: cursor.version - 1, applied, prepared, steps, atomicMoveWork };
		});
	}
	open({ state, log, root }: Parameters<WriterProjectionHost["open"]>[0]): WriterProjectionSession {
		if (this.#active) throw Error("nested projection writers are not supported");
		this.#bind(state);
		source(root);
		const adoption = this.#cursor(state.read(this.#meta, "adoption"));
		const head = this.#head(state.read(this.#meta, "head"), root);
		if (!adoption?.ready || !head || canonicalJson(head.source) !== canonicalJson(root))
			throw Error("projection head is missing, incomplete or stale");
		this.#active = true;
		let live = true,
			observed = root;
		const token = {};
		const overlays: ProjectionOverlayStorage[] = [];
		const scopes: ProjectionReadScope[] = [];
		const membership = new Membership(state);
		const versions = membership.shared.versions;
		const current = (): WriterRoot => {
			if (!live) throw Error("closed projection writer");
			if (log.seq() === observed.logLength && log.generation() !== observed.generation)
				throw Error("projection source changed without an append");
			if (log.seq() !== observed.logLength)
				observed = advanceWriterRoot(log, observed, {
					generation: log.generation(),
					logLength: log.seq(),
					sharedVersion: versions.length - 1,
				});
			return observed;
		};
		const provider =
			(membershipState: GraphStateStorage): WriterProjectionSession["readViewProvider"] =>
			(graph) => {
				const membership = new Membership(membershipState);
				const versions = membership.shared.versions;
				const scope = new ProjectionReadScope(graph, () => (live ? token : undefined));
				scopes.push(scope);
				const readers = new Map<string, ReturnType<typeof projectedReader>>();
				let identity = "";
				const reuse = (key: string, build: () => ReturnType<typeof projectedReader>) => {
					const source = current();
					const next = JSON.stringify([
						graph.size,
						source.generation,
						source.logLength,
						source.digest,
						versions.length,
					]);
					if (next !== identity) {
						readers.clear();
						identity = next;
					}
					const cacheable = key.length <= 8192 && /^(?:v|a) @/.test(key);
					const cached = cacheable ? readers.get(key) : undefined;
					if (cached) {
						scope.guard(graph)();
						return cached;
					}
					const reader = build();
					if (cacheable) {
						if (readers.size >= 32) readers.delete(readers.keys().next().value!);
						readers.set(key, reader);
					}
					return reader;
				};
				return {
					keyed: (key) =>
						reuse(key, () =>
							projectedReader(
								{
									graph,
									context: this.#context,
									sourceGeneration: this.#generation,
									sourceLength: () => current().logLength,
									prefixDigest: (length) =>
										length === current().logLength
											? current().digest
											: (state.read(`${this.#meta}:prefixes`, String(length)) as string | undefined),
									version: () => versions.length - 1,
									committed: () => head,
									at: (version) =>
										state.read(`${this.#meta}:versions`, String(version)) as ProjectionHandle | undefined,
									delta: (version) => versions[version],
									namedVersion: (name, version) => {
										const space = membership.spaces.get(name);
										const selected = space?.versions[version];
										if (!space || selected?.sharedBase === undefined) return undefined;
										return {
											sharedBase: selected.sharedBase,
											atoms: (function* () {
												for (let at = 0; at <= version; at++) {
													const delta = space.versions[at]!;
													if (delta.dropped?.length) throw Error("unexpected named draft removal");
													yield* delta.atoms;
												}
											})(),
										};
									},
									guard: () => scope.guard(graph),
									allocate: () => {
										const overlay = new ProjectionOverlayStorage(
											state,
											`${this.#context.namespace}:${this.#nextOverlay++}`,
											(collection) => state.clearProjectionOverlay(collection),
										);
										overlays.push(overlay);
										return new CachedStateStorage(overlay, overlays.length <= 32 ? 65_536 : 0, 256);
									},
								},
								key,
							),
						),
				};
			};
		return {
			readViewProvider: provider(state),
			historicalReadViewProvider: provider,
			commit: (project, committed) => {
				if (canonicalJson(current()) !== canonicalJson(committed)) throw Error("projection commit source mismatch");
				const commitState = new CachedStateStorage(state, 65_536, 256);
				const adapter = new ExperimentalMarkerProjection(
					commitState,
					project.graph,
					this.#context.defaultFile,
					this.#context.namespace,
				);
				const snapshots = new ProjectionSnapshots(state, adapter, this.#context);
				let value = snapshots.load(head.handle, this.#identity(head.source, head.version));
				let saved = false;
				for (let version = head.version + 1; version <= project.version; version++) {
					for (const item of this.#atoms(project.graph, versions[version]!))
						value = item.remove
							? adapter.removeAtom(value, project.graph.atom(item.id))
							: adapter.apply(value, project.graph.atom(item.id));
					this.#save(state, snapshots, value, committed, version);
					saved = true;
				}
				if (!saved) this.#save(state, snapshots, value, committed, project.version);
			},
			close: () => {
				if (!live) return;
				live = false;
				try {
					for (const scope of scopes) scope.close();
					for (const overlay of overlays) overlay.close();
				} finally {
					this.#active = false;
				}
			},
		};
	}
}
