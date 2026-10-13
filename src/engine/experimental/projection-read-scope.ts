import type { Graph } from "../graph.ts";

/** Private host-owned lifetime. The host closes it in commit/rollback finally blocks. */
export class ProjectionReadScope {
	readonly #graph: Graph;
	readonly #source: () => unknown;
	readonly #identity: unknown;
	readonly #parent: () => void;
	readonly #onClose: () => void;
	#active = true;
	#epoch = 0;
	#child = false;
	constructor(graph: Graph, source: () => unknown, parent = () => {}, onClose = () => {}) {
		this.#graph = graph;
		this.#source = source;
		this.#identity = source();
		this.#parent = parent;
		this.#onClose = onClose;
	}
	#check(): void {
		this.#parent();
		if (!this.#active || this.#source() !== this.#identity) throw Error("expired projection read scope");
	}
	/** Capture this exact graph revision and scope generation, not a mutable validity flag. */
	guard(graph: Graph): () => void {
		this.#check();
		if (graph !== this.#graph || this.#child) throw Error("projection read scope mismatch");
		const epoch = this.#epoch,
			size = graph.size;
		return () => {
			this.#check();
			if (this.#child || this.#epoch !== epoch || graph.size !== size) throw Error("stale projection reader");
		};
	}
	nested(): ProjectionReadScope {
		this.#check();
		if (this.#child) throw Error("projection child scope already active");
		this.#child = true;
		const epoch = ++this.#epoch;
		return new ProjectionReadScope(
			this.#graph,
			this.#source,
			() => {
				this.#check();
				if (this.#epoch !== epoch) throw Error("expired projection parent scope");
			},
			() => {
				this.#child = false;
				this.#epoch++;
			},
		);
	}
	close(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#epoch++;
		this.#onClose();
	}
}
