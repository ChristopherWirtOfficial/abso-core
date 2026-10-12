// A small live graph and a graph rebuilt from its serialized history must
// answer the same one-file record query.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAtom, Graph, View } from "../index.ts";
import { lines, Repo } from "./helpers.ts";

describe("record-query replay contract", () => {
	it("matches a one-file record query after repeated writers, readers, and delete/recreate history", () => {
		const repo = Repo.init({ "src.txt": lines("top", "bottom"), "recreated.txt": lines("old") });
		const base = ["a0"];
		const insertAtTopGap = (text: string) =>
			repo.edit({ edits: [{ file: "src.txt", start: 1, end: 1, lines: [text], mode: "after" }] }, base);
		const writerOne = insertAtTopGap("writer one");
		const writerTwo = insertAtTopGap("writer two");
		const readerOne = insertAtTopGap("reader one");
		const readerTwo = insertAtTopGap("reader two");
		const attrOne = repo.edit({ attrs: [{ file: "src.txt", name: "exec", value: "1" }] }, base);
		const attrTwo = repo.edit({ attrs: [{ file: "src.txt", name: "exec", value: null }] }, base);
		const deletion = repo.edit({ edits: [{ file: "recreated.txt", old: lines("old"), new: "" }] });
		const recreation = repo.edit({ edits: [{ file: "recreated.txt", old: "", new: lines("fresh") }] });

		// Nine existing atoms make a finite, repeatable history. The last query
		// both replaces a line and inserts at the repeatedly written gap.
		assert.equal(repo.graph.size, 9);
		assert.deepEqual(recreation.deps, [deletion.id]);
		assert.deepEqual(repo.graph.closureOf(recreation.deps), repo.graph.closureOf(["a0", deletion.id]));
		assert.deepEqual(repo.view().attrs("src.txt"), {
			exists: false,
			exec: false,
			link: null,
			blob: null,
		});

		const input = {
			author: "record-query-test",
			message: "record one file",
			time: 100,
			edits: [
				{ file: "src.txt", start: 0, end: 1, lines: ["TOP"] },
				{ file: "src.txt", start: 1, end: 1, lines: ["recorded"] },
			],
			attrs: [{ file: "src.txt", name: "exec" as const, value: "1" }],
		};
		const liveAtom = buildAtom(repo.view(), input);
		const expectedDeps = [writerOne.id, writerTwo.id, readerOne.id, readerTwo.id, attrOne.id, attrTwo.id];
		assert.deepEqual(liveAtom.deps, expectedDeps);
		assert.deepEqual(repo.graph.closureOf(liveAtom.deps), repo.graph.closureOf(["a0", ...expectedDeps]));
		assert.equal(liveAtom.deps.length, 6);
		assert.equal(liveAtom.writes.length, 3);
		assert.equal(liveAtom.reads.length, 2);
		assert.equal(liveAtom.holds.length, 0);
		assert.equal(liveAtom.seq, 9);
		assert.deepEqual(liveAtom.deletes, ["a0.1"]);
		assert.deepEqual(liveAtom.inserts, [
			{ file: "src.txt", parent: "a0.1", lines: ["TOP"] },
			{ file: "src.txt", parent: "a0.1", lines: ["recorded"] },
		]);
		assert.deepEqual(liveAtom.attrs, [{ file: "src.txt", name: "exec", value: "1" }]);

		const coldGraph = Graph.fromJSON(JSON.parse(JSON.stringify(repo.graph.toJSON())));
		const coldSet = new Set(repo.shared);
		const coldAtom = buildAtom(new View(coldGraph, coldSet), input);
		assert.deepEqual(coldAtom, liveAtom);
		assert.equal(JSON.stringify(coldAtom), JSON.stringify(liveAtom));
		const perturbedInput = {
			...input,
			edits: input.edits.map((edit, index) => (index === 1 ? { ...edit, lines: ["different"] } : edit)),
		};
		const perturbedAtom = buildAtom(new View(coldGraph, coldSet), perturbedInput);
		assert.notDeepEqual(perturbedAtom, liveAtom);
		assert.notEqual(JSON.stringify(perturbedAtom), JSON.stringify(liveAtom));

		repo.graph.add(liveAtom);
		repo.shared.add(liveAtom.id);
		coldGraph.add(coldAtom);
		coldSet.add(coldAtom.id);
		const liveView = new View(repo.graph, repo.shared);
		const coldView = new View(coldGraph, coldSet);
		const visible = (view: View, path: string) => view.lines(path).map((line) => [line.id, line.text, line.atom]);
		assert.deepEqual(visible(liveView, "src.txt"), visible(coldView, "src.txt"));
		assert.deepEqual(
			visible(liveView, "src.txt").map((line) => line[1]),
			["TOP", "recorded", "reader two", "reader one", "writer two", "writer one", "bottom"],
		);
		assert.deepEqual(liveView.attrs("src.txt"), coldView.attrs("src.txt"));
		assert.equal(liveView.attrs("src.txt").exec, true);
		assert.deepEqual(visible(liveView, "recreated.txt"), visible(coldView, "recreated.txt"));
		assert.deepEqual(
			visible(liveView, "recreated.txt").map((line) => line[1]),
			["fresh"],
		);
		assert.deepEqual(
			liveView.sequence("recreated.txt").map((line) => [line.id, line.text, line.visible, line.deletedBy]),
			[
				[`${recreation.id}.0`, "fresh", true, []],
				["a0.0", "old", false, [deletion.id]],
			],
		);

		const recreatedFileInput = {
			author: "record-query-test",
			message: "record the recreated file",
			time: 101,
			edits: [{ file: "recreated.txt", old: lines("fresh"), new: lines("FRESH") }],
		};
		const liveRecreatedFileAtom = buildAtom(liveView, recreatedFileInput);
		const coldRecreatedFileAtom = buildAtom(coldView, recreatedFileInput);
		assert.deepEqual(liveRecreatedFileAtom.deps, [recreation.id]);
		assert.deepEqual(coldRecreatedFileAtom, liveRecreatedFileAtom);
		assert.equal(JSON.stringify(coldRecreatedFileAtom), JSON.stringify(liveRecreatedFileAtom));
		repo.graph.add(liveRecreatedFileAtom);
		repo.shared.add(liveRecreatedFileAtom.id);
		coldGraph.add(coldRecreatedFileAtom);
		coldSet.add(coldRecreatedFileAtom.id);
		assert.deepEqual(
			visible(new View(repo.graph, repo.shared), "recreated.txt"),
			visible(new View(coldGraph, coldSet), "recreated.txt"),
		);
		assert.deepEqual(
			visible(new View(repo.graph, repo.shared), "recreated.txt").map((line) => line[1]),
			["FRESH"],
		);
		assert.equal(repo.graph.size, 11);
		assert.equal(coldGraph.size, 11);
		assert.equal(JSON.stringify(coldGraph.toJSON()), JSON.stringify(repo.graph.toJSON()));
	});
});
