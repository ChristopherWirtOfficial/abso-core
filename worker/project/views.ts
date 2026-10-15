// The views a project lays out from sets of atoms, cached under a byte budget (#46, disk-first 1). Published
// versions never change, so their views are kept by name. Immutable indexed sets use their identity;
// ordinary in-memory sets use their exact contents.

import { type AtomId, type Graph, type ReadView, View } from "../../src/engine/index.ts";
import { StableSet } from "../../src/engine/state-source.ts";

/**
 * About how many bytes the cached views may hold together (#46). A laid-out
 * line costs about 10 bytes (view.ts), so this holds over 2 million of them;
 * the records a view keeps for the file it was last asked about count too.
 */
const VIEW_BUDGET = 24_000_000;

/**
 * At most this many views (abso Capacity). where visits every agent's draft view in turn: with more agents than views,
 * each visit evicted the next one, and a warm where on abso laid every view out again (4.5 s against 0.33 s). The byte
 * budget still bounds what they hold.
 */
export const VIEW_COUNT = 128;

/** Internal opt-in. The owner validates identity and lifetime on every returned reader. */
export interface ReadViewProvider {
	keyed(key: string): ReadView;
}

/** Views by key, most recently used last, held under VIEW_BUDGET bytes and VIEW_COUNT views. */
export class ViewCache {
	readonly #graph: Graph;
	readonly #provider?: ReadViewProvider;
	readonly #cache = new Map<string | StableSet<AtomId>, View>();

	constructor(graph: Graph, provider?: (graph: Graph) => ReadViewProvider) {
		this.#graph = graph;
		this.#provider = provider?.(graph);
	}
	assertUnkeyedAllowed(): void {
		if (this.#provider) throw Error("unsupported unkeyed projection membership");
	}

	/**
	 * Keep the cached views under VIEW_BUDGET bytes (the website project, #43,
	 * #46): each view holds every line its files ever had, so a few views of a
	 * large generated file add up. At most VIEW_COUNT.
	 */
	#trim(): void {
		let total = 0;
		for (const v of this.#cache.values()) total += v.weight();
		for (const [key, v] of this.#cache) {
			if (total <= VIEW_BUDGET && this.#cache.size <= VIEW_COUNT) break;
			total -= v.weight();
			this.#cache.delete(key);
		}
	}

	/** Indexed snapshots use identity; ordinary sets use their exact contents. */
	view(set: ReadonlySet<AtomId>): ReadView {
		this.assertUnkeyedAllowed();
		// Immutable indexed membership is already a stable identity. Building
		// a sorted history-sized key defeats its external-storage contract.
		if (set instanceof StableSet) return this.#get(set, () => set);
		const key = [...set]
			.map((id) => this.#graph.atom(id).seq)
			.sort((a, b) => a - b)
			.join(",");
		return this.keyed(key, () => set);
	}

	/** A view cached under `key`, made from `set()` when it isn't there. */
	keyed(key: string, set: () => ReadonlySet<AtomId>): ReadView {
		if (this.#provider) return this.#provider.keyed(key);
		return this.#get(key, set);
	}

	#get(key: string | StableSet<AtomId>, set: () => ReadonlySet<AtomId>): View {
		let view = this.#cache.get(key);
		if (view) {
			// Most recently used last, so eviction takes the oldest.
			this.#cache.delete(key);
		} else {
			view = new View(this.#graph, set());
		}
		// Account the selected view, including growth since its last access,
		// before evicting older entries. An oversized view may evict itself.
		this.#cache.set(key, view);
		this.#trim();
		return view;
	}
}
