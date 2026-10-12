// The views a project lays out from sets of atoms, cached under a byte budget (#46, disk-first 1). Published
// versions never change, so their views are kept by name; any other set is kept by its exact contents.

import { type AtomId, type Graph, View } from "../../src/engine/index.ts";

/**
 * About how many bytes the cached views may hold together (#46). A laid-out
 * line costs about 10 bytes (view.ts), so this holds over 2 million of them;
 * the records a view keeps for the file it was last asked about count too.
 */
const VIEW_BUDGET = 24_000_000;

/** Views by key, most recently used last, held under VIEW_BUDGET bytes and 32 views. */
export class ViewCache {
	readonly #graph: Graph;
	readonly #cache = new Map<string, View>();

	constructor(graph: Graph) {
		this.#graph = graph;
	}

	/**
	 * Keep the cached views under VIEW_BUDGET bytes (the website project, #43,
	 * #46): each view holds every line its files ever had, so a few views of a
	 * large generated file add up. At most 32.
	 */
	#trim(): void {
		let total = 0;
		for (const v of this.#cache.values()) total += v.weight();
		for (const [key, v] of this.#cache) {
			if (total <= VIEW_BUDGET && this.#cache.size <= 32) break;
			total -= v.weight();
			this.#cache.delete(key);
		}
	}

	/** A view of a set, cached by the set's exact contents. */
	view(set: ReadonlySet<AtomId>): View {
		const key = [...set]
			.map((id) => this.#graph.atom(id).seq)
			.sort((a, b) => a - b)
			.join(",");
		return this.keyed(key, () => set);
	}

	/** A view cached under `key`, made from `set()` when it isn't there. */
	keyed(key: string, set: () => ReadonlySet<AtomId>): View {
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
