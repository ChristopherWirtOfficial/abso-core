import { type GraphStateStorage, StoredMap } from "../../src/engine/state-source.ts";
import type { AgentState } from "./project-types.ts";

type StoredAgent = Omit<AgentState, "told" | "parked"> & {
	told: string[];
	parked: [string, { base: number; mine: AgentState["mine"] }][];
};

/**
 * Identity map for agents touched by the current operation. Project's existing
 * reducers share mutable agent references, so copies cannot be substituted
 * halfway through an operation. Flush those rows with the canonical append,
 * then drop the references. Opening this map does not load any agents.
 */
export class WriterAgents extends StoredMap<string, AgentState> {
	readonly #touched = new Map<string, AgentState>();
	constructor(storage: GraphStateStorage) {
		super(storage, "project:agents", {
			encode: (agent) => ({ ...agent, told: [...agent.told], parked: [...agent.parked] }),
			decode: (value) => {
				const agent = value as StoredAgent;
				return { ...agent, told: new Set(agent.told), parked: new Map(agent.parked) };
			},
		});
	}
	override get(key: string): AgentState | undefined {
		let value = this.#touched.get(key);
		if (!value) {
			value = super.get(key);
			if (value) this.#touched.set(key, value);
		}
		return value;
	}
	override set(key: string, value: AgentState): this {
		super.set(key, value);
		this.#touched.set(key, value);
		return this;
	}
	override delete(key: string): boolean {
		this.#touched.delete(key);
		return super.delete(key);
	}
	override *entries(): MapIterator<[string, AgentState]> {
		for (const [key, stored] of super.entries()) {
			let value = this.#touched.get(key);
			if (!value) this.#touched.set(key, (value = stored));
			yield [key, value];
		}
	}
	flush(): void {
		for (const [key, value] of this.#touched) super.set(key, value);
		this.#touched.clear();
	}
}
