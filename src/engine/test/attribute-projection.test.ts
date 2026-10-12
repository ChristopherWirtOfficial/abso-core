import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../graph.ts";
import { CachedStateStorage, StableOverlaySet } from "../state-source.ts";
import { View } from "../view.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("attribute queries and explicit file existence do not traverse line history", (t) => {
	const repo = Repo.init({ "file.txt": "one\ntwo\n" });
	const base = new Set(repo.shared);
	repo.edit({
		attrs: [
			{ file: "file.txt", name: "exec", value: "1" },
			{ file: "empty.txt", name: "exists", value: "1" },
			{ file: "link.txt", name: "link", value: "target" },
		],
	});
	const first = new Set(repo.shared);
	repo.edit({
		attrs: [
			{ file: "file.txt", name: "exec", value: null },
			{ file: "empty.txt", name: "exists", value: null },
			{ file: "link.txt", name: "link", value: null },
		],
	});
	const source = new SqlState();
	try {
		const disk = new Graph({ storage: new CachedStateStorage(source) });
		for (const id of repo.shared) disk.add(repo.graph.atom(id));
		for (const graph of [repo.graph, new Graph({ storage: new CachedStateStorage(source) })]) {
			for (const set of [base, first, repo.shared]) {
				const view = new View(graph, new StableOverlaySet(set));
				const before = view.weight();
				const guard = t.mock.method(graph, "startCodeOf", () => {
					throw new Error("line traversal forbidden");
				});
				assert.equal(view.attrs("file.txt").exec, set === first);
				assert.equal(view.attrs("empty.txt").exists, set === first);
				assert.equal(view.attrs("link.txt").link, set === first ? "target" : null);
				assert.deepEqual(view.attrs("missing.txt"), { exists: false, exec: false, link: null, blob: null });
				if (set === first) {
					assert.equal(view.hasFile("empty.txt"), true);
					assert.equal(view.hasFile("link.txt"), true);
				}
				assert.equal(view.weight(), before);
				guard.mock.restore();
				assert.equal(view.hasFile("file.txt"), true, "text-only files retain line fallback");
				assert.equal(view.hasFile("missing.txt"), false);
				assert.equal(view.hasFile("empty.txt"), set === first);
				assert.equal(view.text("file.txt"), "one\ntwo\n");
			}
		}
	} finally {
		source.db.close();
	}
});
