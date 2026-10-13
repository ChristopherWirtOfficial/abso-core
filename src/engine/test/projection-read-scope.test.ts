import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import { ProjectionReadScope } from "../experimental/projection-read-scope.ts";
import { ProjectionReader } from "../experimental/projection-reader.ts";
import { Graph } from "../graph.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

for (const end of ["commit", "rollback", "source", "nested", "graph"] as const) {
	test(`projected reads reject stale methods, membership and iterator resume after ${end}`, (t) => {
		const storage = new SqlState();
		try {
			const repo = Repo.init({ "f.txt": "one\ntwo\n" });
			const graph = new Graph();
			graph.add(repo.graph.atom("a0"));
			const adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "scope-test");
			const state = adapter.apply(adapter.empty(), graph.atom("a0"));
			let source = {};
			const scope = new ProjectionReadScope(graph, () => source);
			assert.throws(() => scope.guard(new Graph()), /mismatch/);
			const reader = new ProjectionReader(adapter, state, scope.guard(graph));
			const membership = reader.set;
			const iterator = reader.visibleLines("f.txt");
			assert.equal(iterator.next().value?.text, "one");
			if (end === "source") source = {};
			else if (end === "nested") {
				const child = scope.nested();
				assert.throws(() => reader.text("f.txt"), /stale/);
				const childGuard = child.guard(graph);
				childGuard();
				child.close();
				assert.throws(childGuard, /expired/);
				scope.guard(graph)();
			} else if (end === "graph") {
				repo.edit({ edits: [{ file: "f.txt", old: "one\ntwo\n", new: "changed\n" }] });
				graph.add(repo.graph.atom("a1"));
			} else scope.close();
			let touched = false;
			const refuseAccess = () => {
				touched = true;
				throw Error("expired reader touched data");
			};
			t.mock.method(storage, "read", refuseAccess);
			t.mock.method(storage, "entries", refuseAccess);
			t.mock.method(graph, "lineN", refuseAccess);
			t.mock.method(graph, "textOf", refuseAccess);
			assert.throws(() => reader.text("f.txt"), /expired|stale/);
			assert.throws(() => membership.has("a0"), /expired|stale/);
			assert.throws(() => iterator.next(), /expired|stale/);
			assert.equal(touched, false);
		} finally {
			storage.db.close();
		}
	});
}
