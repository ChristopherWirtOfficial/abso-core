import { canonicalJson } from "../../worker/project/operation-protocol.ts";
import { Project, type WriterSource } from "../../worker/project/project.ts";
import type { ProjectOptions } from "../../worker/project/project-types.ts";
import { EngineProject, SqliteLog, type SqliteStorage } from "./engine-project.ts";
import { SqliteProjectionStore } from "./projection-store.ts";
import { SqliteWriterHost, SqliteWriterState } from "./writer-host.ts";

type Services = Pick<ProjectOptions, "hasBlob" | "whole">;
type Progress = { ready: boolean; phase: "empty" | "writer" | "projection" | "ready"; next: number };

/** One synchronous page or call per invocation. No object retains a loaded Project.
 * The owner schedules subsequent pages and supplies fresh authorization for every call. */
export class DiskFirstRuntime {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	readonly #projection: SqliteProjectionStore;
	readonly #services: Services;
	constructor(storage: SqliteStorage, database: string, namespace: string, services: Services = {}) {
		this.#storage = storage;
		this.#namespace = namespace;
		this.#services = services;
		this.#projection = new SqliteProjectionStore(
			{
				database,
				namespace: `${namespace}:views`,
				registry: `${namespace}:roots`,
				defaultFile: "__abso_projection_default__",
			},
			1,
			{ indexedAtoms: true },
		);
	}
	#host() {
		return new SqliteWriterHost(this.#storage, this.#namespace, this.#projection, { indexProjectionAtoms: true });
	}
	#state() {
		return new SqliteWriterState(this.#storage, this.#namespace);
	}
	#validate(validate: () => void) {
		const result: unknown = validate();
		if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
			throw Error("runtime authorization must be synchronous");
	}
	#setup() {
		SqliteWriterState.initialize(this.#storage);
		const state = this.#state();
		const format = state.read("runtime", "format");
		if (format !== undefined && format !== 1) throw Error("unsupported disk-first runtime format");
		if (format === undefined) state.write("runtime", "format", 1);
		return state;
	}
	/** Initializes an empty canonical log without replay. Existing history must be adopted. */
	initialize<T>(operation: (calls: EngineProject) => T, validate: () => void): T {
		return this.#storage.transactionSync(() => {
			this.#validate(validate);
			const log = new SqliteLog(this.#storage);
			if (log.seq() !== 0) throw Error("disk-first initialization requires an empty log");
			const project = new Project(log, { ...this.#services, now: () => Date.now(), shapes: log.shapes() });
			const result = structuredClone(operation(new EngineProject(project)));
			this.#validate(validate);
			return result;
		});
	}
	preparePage(validate: () => void): Progress {
		return this.#storage.transactionSync(() => {
			this.#validate(validate);
			const log = new SqliteLog(this.#storage);
			if (log.seq() === 0) {
				this.#validate(validate);
				return { ready: false, phase: "empty", next: 0 };
			}
			const state = this.#setup();
			const host = this.#host();
			const ready = state.read("runtime", "ready");
			if (ready !== undefined && ready !== true) throw Error("invalid runtime readiness marker");
			if (ready === true) {
				const root = host.root();
				const scope = this.#projection.open({ state, log, root });
				scope.close();
				this.#validate(validate);
				return { ready: true, phase: "ready", next: root.logLength };
			}
			const bound = state.read("host", "canonical-root");
			if (bound === undefined) {
				const cursor = state.read("host", "adoption-root") as
					| { source: WriterSource; next: number; digest: string }
					| undefined;
				const page = host.adoptVerifiedPage(
					{
						expected: cursor?.source ?? host.source(),
						from: cursor?.next ?? 0,
						digest: cursor?.digest ?? "",
						maxEntries: 32,
						maxBytes: 1_048_576,
					},
					validate,
				);
				this.#validate(validate);
				return { ready: false, phase: "writer", next: page.next };
			}
			const root = host.root();
			const page = this.#projection.adopt({
				state,
				expected: root,
				currentRoot: () => host.root(),
				maxAtoms: 32,
				maxVersions: 1,
				maxSteps: 32,
			});
			this.#validate(validate);
			if (page.ready) state.write("runtime", "ready", true);
			return { ready: page.ready, phase: page.ready ? "ready" : "projection", next: root.logLength };
		});
	}
	#requireReady() {
		if (
			this.#storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writer_state'").toArray()
				.length === 0
		)
			throw Error("disk-first adoption is not complete");
		if (this.#state().read("runtime", "format") !== 1 || this.#state().read("runtime", "ready") !== true)
			throw Error("disk-first adoption is not complete");
	}
	read<T>(operation: (calls: EngineProject) => T, validate: () => void): T {
		this.#requireReady();
		const host = this.#host();
		return host.readCalls({
			expected: host.source(),
			validateAuthority: validate,
			services: this.#services,
			operation: (calls) => structuredClone(operation(calls)),
		});
	}
	write<T>(
		operation: (calls: EngineProject) => T,
		validate: () => void,
		request?: { id: string; identity: unknown },
	): T {
		return this.#storage.transactionSync(() => {
			this.#validate(validate);
			this.#requireReady();
			const state = this.#state();
			const host = this.#host();
			host.root();
			if (request && (!request.id || request.id.length > 128)) throw Error("invalid disk-first request identity");
			const identity = request ? canonicalJson(request.identity) : undefined;
			if (request) {
				const receipt = state.read("runtime:receipts", request.id) as { identity: string; result: T } | undefined;
				if (receipt) {
					if (receipt.identity !== identity) throw Error("disk-first request identity was reused");
					this.#validate(validate);
					return structuredClone(receipt.result);
				}
			}
			return host.runCalls({
				expected: host.source(),
				validateAuthority: validate,
				services: this.#services,
				checkerReady: false,
				operation: (calls) => structuredClone(operation(calls)),
				commitReceipt: (result) => {
					if (request) state.write("runtime:receipts", request.id, { identity, result });
				},
			});
		});
	}
}
