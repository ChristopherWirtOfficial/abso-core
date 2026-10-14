import assert from "node:assert/strict";
import { it } from "node:test";
import { Repo } from "../../../src/engine/test/helpers.ts";
import type { AgentState } from "../project-types.ts";
import { type RecordFileHost, recordFile } from "../record-file.ts";

it("records replacements without materializing old file text or line arrays", () => {
	const view = Repo.init({ "large.txt": `${"x".repeat(100000)}\nkeep\n` }).view();
	view.text = () => {
		throw Error("whole old text is forbidden");
	};
	view.lines = () => {
		throw Error("old line array is forbidden");
	};
	const calls: Parameters<RecordFileHost["addDraft"]>[2][] = [];
	const host: RecordFileHost = {
		addDraft(_agent, _view, input) {
			calls.push(input);
		},
	};
	const agent: AgentState = {
		name: "writer",
		space: "",
		base: 0,
		synced: true,
		mine: [],
		news: [],
		newsAt: [],
		told: new Set(),
		parked: new Map(),
		marked: [],
	};
	assert.equal(recordFile(host, agent, view, "large.txt", "changed\nkeep\n", 1, {}, []), true);
	assert.deepEqual(calls[0]!.edits, [{ file: "large.txt", start: 0, end: 1, lines: ["changed"] }]);
	const unchanged = `${"x".repeat(100000)}\nkeep\n`;
	assert.equal(recordFile(host, agent, view, "large.txt", unchanged, 1, {}, []), false);
	assert.equal(
		recordFile(host, agent, view, "large.txt", unchanged, 1, {}, [], {}, undefined, [
			{ start: 0, end: 1, lines: ["ignored"] },
		]),
		false,
	);
	assert.equal(calls.length, 1);
});
