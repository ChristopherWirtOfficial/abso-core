import { createHash } from "node:crypto";
import { canonicalJson } from "../../worker/project/operation-protocol.ts";
import { Project, type WriterSource } from "../../worker/project/project.ts";
import type { ProjectOptions } from "../../worker/project/project-types.ts";
import { EngineProject, SqliteLog, type SqliteStorage } from "./engine-project.ts";
import { SqliteHistoryHost } from "./history-host.ts";
import { SqliteProjectionStore } from "./projection-store.ts";
import { SqliteWriterHost, SqliteWriterState } from "./writer-host.ts";

type Services = Pick<ProjectOptions, "hasBlob" | "whole">;
type Progress = { ready: boolean; phase: "empty" | "writer" | "projection" | "history" | "ready"; next: number };

/** One synchronous page or call per invocation. No object retains a loaded Project.
 * The owner schedules subsequent pages and supplies fresh authorization for every call. */
export class DiskFirstRuntime {
	readonly #storage: SqliteStorage;
	readonly #namespace: string;
	readonly #projection: SqliteProjectionStore;
	readonly #services: Services;
	readonly #history: SqliteHistoryHost;
	constructor(storage: SqliteStorage, database: string, namespace: string, services: Services = {}) {
		this.#storage = storage;
		this.#namespace = namespace;
		this.#services = services;
		this.#history = new SqliteHistoryHost(storage, `${namespace}:history`);
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
		return new SqliteWriterHost(this.#storage, this.#namespace, this.#projection, {
			indexProjectionAtoms: true,
			history: this.#history,
		});
	}
	#state() {
		return new SqliteWriterState(this.#storage, this.#namespace);
	}
	#saveReceipt(state: SqliteWriterState, id: string, identity: string, result: unknown) {
		// Receipt payloads can exceed the graph-state value bound. Keep each stored
		// piece small without increasing that bound for engine state.
		const json = JSON.stringify({ result });
		const characters = 64 * 1024;
		const parts = Math.ceil(json.length / characters);
		for (let part = 0; part < parts; part++)
			state.write(`runtime:receipt:${id}`, String(part), json.slice(part * characters, (part + 1) * characters));
		state.write("runtime:receipts", id, {
			format: 3,
			identity,
			parts,
			characters: json.length,
			digest: createHash("sha256").update(json).digest("hex"),
		});
	}
	#receiptResult<T>(
		state: SqliteWriterState,
		id: string,
		receipt: { format: number; result?: T; parts?: number; characters?: number; digest?: string },
	): T {
		if (receipt.format === 2) return structuredClone(receipt.result) as T;
		if (
			receipt.format !== 3 ||
			!Number.isSafeInteger(receipt.parts) ||
			receipt.parts! < 1 ||
			!Number.isSafeInteger(receipt.characters) ||
			receipt.characters! < 1 ||
			receipt.parts !== Math.ceil(receipt.characters! / (64 * 1024))
		)
			throw Error("invalid receipt header");
		let json = "";
		for (let part = 0; part < receipt.parts!; part++) {
			const chunk = state.read(`runtime:receipt:${id}`, String(part));
			if (typeof chunk !== "string" || chunk.length !== Math.min(64 * 1024, receipt.characters! - part * 64 * 1024))
				throw Error("incomplete receipt payload");
			json += chunk;
		}
		if (createHash("sha256").update(json).digest("hex") !== receipt.digest)
			throw Error("receipt payload digest mismatch");
		return (JSON.parse(json) as { result: T }).result;
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
		if (format !== undefined && format !== 1 && format !== 2 && format !== 3 && format !== 4 && format !== 5)
			throw Error("unsupported disk-first runtime format");
		// Format 5 additionally fences indexed insertion runs and lines from older readers.
		// Never lower this marker in place.
		if (format !== 5) state.write("runtime", "format", 5);
		return state;
	}
	/** Initializes an empty canonical log without replay. Existing history must be adopted. */
	initialize<T>(
		operation: (calls: EngineProject) => T,
		validate: () => void,
		request?: { id: string; identity: unknown },
	): T {
		return this.#storage.transactionSync(() => {
			this.#validate(validate);
			const log = new SqliteLog(this.#storage);
			if (log.seq() !== 0) throw Error("disk-first initialization requires an empty log");
			if (request && (!request.id || request.id.length > 128)) throw Error("invalid disk-first request identity");
			const project = new Project(log, { ...this.#services, now: () => Date.now(), shapes: log.shapes() });
			const result = structuredClone(operation(new EngineProject(project)));
			this.#validate(validate);
			if (request && log.seq() > 0)
				this.#saveReceipt(
					this.#setup(),
					request.id,
					createHash("sha256").update(canonicalJson(request.identity)).digest("hex"),
					result,
				);
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
				const history = this.#history.prepare(log, root, () => host.root(), validate);
				if (!history.ready) {
					state.remove("runtime", "history-ready");
					return { ready: false, phase: "history", next: history.next };
				}
				state.write("runtime", "history-ready", true);
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
						maxBytes: log.adoptionPageBytes(cursor?.next ?? 0),
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
			if (!page.ready) return { ready: false, phase: "projection", next: root.logLength };
			const history = this.#history.prepare(log, root, () => host.root(), validate);
			if (history.ready) {
				state.write("runtime", "ready", true);
				state.write("runtime", "history-ready", true);
			}
			return { ready: history.ready, phase: history.ready ? "ready" : "history", next: history.next };
		});
	}
	#requireReady() {
		if (
			this.#storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writer_state'").toArray()
				.length === 0
		)
			throw Error("disk-first adoption is not complete");
		if (
			this.#state().read("runtime", "format") !== 5 ||
			this.#state().read("runtime", "ready") !== true ||
			this.#state().read("runtime", "history-ready") !== true
		)
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
			const identity = request ? createHash("sha256").update(canonicalJson(request.identity)).digest("hex") : undefined;
			if (request) {
				const receipt = state.read("runtime:receipts", request.id) as
					| { format: number; identity: string; result: T }
					| undefined;
				if (receipt) {
					if (receipt.format !== 2 && receipt.format !== 3) throw Error("unsupported disk-first receipt format");
					if (receipt.identity !== identity)
						throw Object.assign(Error("disk-first request identity was reused"), { code: "request-reused" });
					this.#validate(validate);
					return this.#receiptResult<T>(state, request.id, receipt);
				}
			}
			return host.runCalls({
				expected: host.source(),
				validateAuthority: validate,
				services: this.#services,
				checkerReady: false,
				operation: (calls) => structuredClone(operation(calls)),
				commitReceipt: (result) => {
					if (request) this.#saveReceipt(state, request.id, identity!, result);
				},
			});
		});
	}
}
