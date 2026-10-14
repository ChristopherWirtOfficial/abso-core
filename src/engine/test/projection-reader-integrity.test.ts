import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { ProjectionReader } from "../experimental/projection-reader.ts";
import { Graph } from "../graph.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("file lookup rejects a missing marker for an included writer instead of following ancestry", (t) => {
	const storage = new SqlState();
	t.after(() => storage.db.close());
	const repo = Repo.init({ "f.txt": "one\ntwo\n" });
	const graph = new Graph({ storage });
	graph.add(repo.graph.atom("a0"));
	const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "included-marker");
	const state = adapter.apply(adapter.empty(), graph.atom("a0"));
	const reader = new ProjectionReader(adapter, state, () => {});
	const line = [...adapter.lineIds(state, "f.txt")][0]!;
	assert.equal(reader.fileOf(line), "f.txt");
	const markerKey = graph.lineN(line) + 1;
	const get = adapter.markers.get.bind(adapter.markers);
	t.mock.method(adapter.markers, "get", (root: Parameters<typeof get>[0], key: number) =>
		key === markerKey ? undefined : get(root, key),
	);
	t.mock.method(graph, "lineParent", () => {
		throw Error("included writer must not use ancestry fallback");
	});
	assert.throws(() => reader.fileOf(line), /missing projected line/);
});
