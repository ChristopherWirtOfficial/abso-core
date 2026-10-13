import type { GraphStateStorage } from "../state-source.ts";
import type { ExperimentalMarkerProjection, MarkerState } from "./projection-marker.ts";
import {
	assertProjectionIdentity,
	createProjectionRoot,
	type ProjectionHandle,
	type ProjectionIdentity,
	readProjectionRoot,
} from "./projection-root.ts";

type Context = Pick<ProjectionIdentity, "database" | "namespace" | "registry" | "defaultFile">;
/** Internal snapshot boundary. The host supplies verified canonical and membership identities. */
export class ProjectionSnapshots {
	readonly #storage: GraphStateStorage;
	readonly #adapter: ExperimentalMarkerProjection;
	readonly #context: Context;
	readonly #collection: string;
	constructor(storage: GraphStateStorage, adapter: ExperimentalMarkerProjection, context: Context) {
		this.#storage = storage;
		this.#adapter = adapter;
		this.#context = {
			database: context.database,
			namespace: context.namespace,
			registry: context.registry,
			defaultFile: context.defaultFile,
		};
		this.#collection = `experimental-projection:${JSON.stringify([context.database, context.namespace])}:context`;
		if (adapter.context !== JSON.stringify([context.namespace, context.defaultFile]))
			throw Error("projection snapshot constructor mismatch");
	}
	#expected(expected: ProjectionIdentity): void {
		assertProjectionIdentity(expected, expected);
		for (const field of ["database", "namespace", "registry", "defaultFile"] as const)
			if (expected[field] !== this.#context[field]) throw Error(`projection snapshot context mismatch: ${field}`);
	}
	#registry(create: boolean): void {
		const stored = this.#storage.read(this.#collection, "binding");
		if (stored === undefined) {
			if (!create) throw Error("missing projection registry binding");
			this.#storage.write(this.#collection, "binding", this.#context);
			return;
		}
		if (!stored || typeof stored !== "object" || Array.isArray(stored) || Object.keys(stored).length !== 4)
			throw Error("invalid projection registry binding");
		for (const field of ["database", "namespace", "registry", "defaultFile"] as const)
			if ((stored as Record<string, unknown>)[field] !== this.#context[field])
				throw Error("projection registry binding mismatch");
	}
	save(id: number, expected: ProjectionIdentity, state: MarkerState): ProjectionHandle {
		this.#expected(expected);
		this.#adapter.assertContext(state);
		return this.#storage.transaction(() => {
			this.#registry(true);
			if (state.sequence.root !== null) this.#adapter.sequence.rank(state.sequence, state.sequence.root);
			return createProjectionRoot(this.#storage, expected, id, {
				sequence: state.sequence.map,
				sequenceRoot: state.sequence.root,
				sequenceNext: state.sequence.next,
				locator: state.locator,
				children: state.children,
				membership: state.membership,
				attributes: state.attributeFiles,
			});
		});
	}
	load(handle: ProjectionHandle, expected: ProjectionIdentity): MarkerState {
		this.#expected(expected);
		assertProjectionIdentity(handle.identity, expected);
		this.#registry(false);
		const roots = readProjectionRoot(this.#storage, handle, expected);
		const state: MarkerState = {
			context: this.#adapter.context,
			sequence: { map: roots.sequence, root: roots.sequenceRoot, next: roots.sequenceNext },
			locator: roots.locator,
			children: roots.children,
			membership: roots.membership,
			attributeFiles: roots.attributes,
		};
		if (state.sequence.root !== null) this.#adapter.sequence.rank(state.sequence, state.sequence.root);
		return state;
	}
}
