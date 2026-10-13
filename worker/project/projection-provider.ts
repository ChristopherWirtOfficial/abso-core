import { ExperimentalMarkerProjection } from "../../src/engine/experimental/projection-marker.ts";
import { ProjectionReader } from "../../src/engine/experimental/projection-reader.ts";
import type { ProjectionHandle, ProjectionIdentity } from "../../src/engine/experimental/projection-root.ts";
import { ProjectionSnapshots } from "../../src/engine/experimental/projection-snapshots.ts";
import type { Graph } from "../../src/engine/graph.ts";
import type { GraphStateStorage } from "../../src/engine/state-source.ts";
import type { Published } from "./spaces.ts";

/** Internal host contract; canonical proofs and version authority are independent of saved handles. */
export interface ProjectionReadBinding {
	readonly graph: Graph;
	readonly context: Pick<ProjectionIdentity, "database" | "namespace" | "registry" | "defaultFile">;
	readonly sourceGeneration: number;
	sourceLength(): number;
	prefixDigest(length: number): string | undefined;
	version(): number;
	committed(): { version: number; handle: ProjectionHandle };
	at(version: number): ProjectionHandle | undefined;
	delta(version: number): Published | undefined;
	/** Read-through overlay owned and cleaned by the current transaction. */
	allocate(): GraphStateStorage;
	/** Checks this exact transaction, graph revision and verified source binding. */
	guard(): () => void;
}

/** Explicit private route. Unsupported memberships never fall back to historical View construction. */
export function projectedReader(binding: ProjectionReadBinding, key: string): ProjectionReader {
	const scopeGuard = binding.guard();
	scopeGuard();
	const sourceLength = binding.sourceLength(),
		sourceGeneration = binding.sourceGeneration;
	const sourceDigest = binding.prefixDigest(sourceLength);
	if (sourceDigest === undefined) throw Error("missing verified current canonical prefix");
	const assertLive = () => {
		scopeGuard();
		if (
			binding.sourceGeneration !== sourceGeneration ||
			binding.sourceLength() !== sourceLength ||
			binding.prefixDigest(sourceLength) !== sourceDigest
		)
			throw Error("expired projection source binding");
	};
	assertLive();
	const match = /^(v|a) @(0|[1-9]\d*)(?:\+(.+))?$/.exec(key);
	if (!match || (match[1] === "v" && match[3])) throw Error(`unsupported projection key: ${key}`);
	const version = Number(match[2]);
	if (!Number.isSafeInteger(version) || version > binding.version())
		throw Error("projection version outside authority");
	const exact = binding.at(version);
	const anchor = exact ? { version, handle: exact } : binding.committed();
	if (!Number.isSafeInteger(anchor.version) || anchor.version < 0 || (!exact && version <= anchor.version))
		throw Error("missing historical version projection");
	const length = anchor.handle.identity.sourceLength;
	if (!Number.isSafeInteger(length) || length < 0 || length > binding.sourceLength())
		throw Error("projection source outside authority");
	const digest = binding.prefixDigest(length);
	if (digest === undefined) throw Error("missing verified canonical prefix");
	const storage = binding.allocate();
	const context = { ...binding.context };
	const adapter = new ExperimentalMarkerProjection(storage, binding.graph, context.defaultFile, context.namespace);
	const snapshots = new ProjectionSnapshots(storage, adapter, context);
	let state = snapshots.load(anchor.handle, {
		...context,
		sourceGeneration: binding.sourceGeneration,
		sourceLength: length,
		sourceDigest: digest,
		membership: String(anchor.version),
	});
	for (let next = anchor.version + 1; next <= version; next++) {
		const delta = binding.delta(next);
		if (!delta || delta.version !== next) throw Error("missing transaction-local version delta");
		for (const atom of [...(delta.dropped ?? [])].map((id) => binding.graph.atom(id)).sort((a, b) => b.seq - a.seq))
			state = adapter.removeAtom(state, atom);
		for (const atom of delta.atoms.map((id) => binding.graph.atom(id)).sort((a, b) => a.seq - b.seq))
			state = adapter.apply(state, atom);
	}
	for (const id of match[3]?.split(",") ?? []) state = adapter.apply(state, binding.graph.atom(id));
	assertLive();
	return new ProjectionReader(adapter, state, assertLive);
}
