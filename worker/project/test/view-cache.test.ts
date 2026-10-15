import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadView } from "../../../src/engine/index.ts";
import { buildBase, Graph, View } from "../../../src/engine/index.ts";
import { StableOverlaySet } from "../../../src/engine/state-source.ts";
import type { AtomId } from "../../../src/engine/types.ts";
import { VIEW_COUNT, ViewCache } from "../views.ts";

const VIEW_BUDGET = 24_000_000;

test("indexed view cache keys never enumerate membership and remain bounded by eviction", () => {
	class Counted extends StableOverlaySet<AtomId> {
		iterations = 0;
		override values(): SetIterator<AtomId> {
			this.iterations++;
			return super.values();
		}
	}
	const graph = new Graph();
	graph.add(buildBase({ "a.txt": "one\n" }, { author: "test", message: "base" }));
	const cache = new ViewCache(graph);
	const set = new Counted(["a0"]);
	const view = cache.view(set);
	assert.equal(set.iterations, 1, "only View closure validation enumerates membership");
	assert.equal(cache.view(set), view);
	assert.equal(set.iterations, 1, "cache hit must not construct a full-history key");
	assert.equal(view.text("a.txt"), "one\n");
	for (let i = 0; i < VIEW_COUNT + 1; i++) cache.view(new Counted(["a0"]));
	assert.notEqual(cache.view(set), view, "indexed identities obey the same cache eviction limit");
	assert.equal(set.iterations, 2);
});

type WeightControls = {
	setIncomingWeights(values: number[]): void;
	setWeight(view: ReadView, weight: number): void;
};

function withControlledWeights(run: (controls: WeightControls) => void): void {
	const original = Object.getOwnPropertyDescriptor(View.prototype, "weight")!;
	const weights = new WeakMap<ReadView, number>();
	let newWeights: number[] = [];
	Object.defineProperty(View.prototype, "weight", {
		configurable: true,
		value(this: ReadView) {
			if (!weights.has(this)) weights.set(this, newWeights.shift() ?? 0);
			return weights.get(this)!;
		},
	});
	const controls: WeightControls = {
		setWeight: (view, weight) => {
			weights.set(view, weight);
		},
		setIncomingWeights: (values) => {
			newWeights = [...values];
		},
	};
	try {
		run(controls);
	} finally {
		Object.defineProperty(View.prototype, "weight", original);
	}
}

function get(cache: ViewCache, key: string): ReadView {
	return cache.keyed(key, () => new Set());
}

test("the incoming view counts toward the retained byte budget", () => {
	withControlledWeights((control) => {
		const cache = new ViewCache(new Graph());
		control.setIncomingWeights([10_000_000, 15_000_001]);
		const old = get(cache, "old");
		const incoming = get(cache, "incoming");
		assert.equal(get(cache, "incoming"), incoming);
		assert.notEqual(get(cache, "old"), old);
	});
});

test("the cache retains exactly VIEW_COUNT views and evicts the least recently used one", () => {
	withControlledWeights((control) => {
		const cache = new ViewCache(new Graph());
		control.setIncomingWeights(Array(VIEW_COUNT + 1).fill(0));
		const first = get(cache, "key-0");
		const retained = Array.from({ length: VIEW_COUNT - 1 }, (_, i) => get(cache, `key-${i + 1}`));
		assert.equal(get(cache, "key-0"), first);
		const last = get(cache, `key-${VIEW_COUNT}`);
		assert.equal(get(cache, "key-0"), first);
		assert.equal(get(cache, `key-${VIEW_COUNT}`), last);
		for (let i = 1; i < retained.length; i++) assert.equal(get(cache, `key-${i + 1}`), retained[i]);
		assert.notEqual(get(cache, "key-1"), retained[0]);
	});
});

test("a repeated hit reweighs lazy growth and evicts older entries", () => {
	withControlledWeights((control) => {
		const cache = new ViewCache(new Graph());
		control.setIncomingWeights([10_000_000, 10_000_000]);
		const growing = get(cache, "growing");
		const older = get(cache, "older");
		control.setWeight(growing, 16_000_000);
		assert.equal(get(cache, "growing"), growing);
		assert.notEqual(get(cache, "older"), older);
	});
});

test("an oversized view is returned but not retained", () => {
	withControlledWeights((control) => {
		const cache = new ViewCache(new Graph());
		control.setIncomingWeights([VIEW_BUDGET + 1, 0]);
		const oversized = get(cache, "large");
		assert.ok(oversized instanceof View);
		assert.notEqual(get(cache, "large"), oversized);
	});
});

test("cache eviction preserves real Graph and View layouts", () => {
	const graph = new Graph();
	graph.add(
		buildBase(
			{ "notes.txt": "one\ntwo\n", "folder/readme.md": "cached view\n" },
			{ author: "test", message: "view cache" },
		),
	);
	const set = new Set(["a0"]);
	const cache = new ViewCache(graph);
	const cached = cache.view(set);
	const expected = new View(graph, set);
	assert.deepEqual(cached.files(), expected.files());
	assert.equal(cached.text("notes.txt"), expected.text("notes.txt"));
	for (let i = 0; i < 40; i++) cache.keyed(`other-${i}`, () => set);
	assert.deepEqual(cache.view(set).files(), new View(graph, set).files());
});
