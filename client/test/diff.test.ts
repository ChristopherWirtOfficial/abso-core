// The client's line diff: hunks as git prints them, and edit scripts that are
// correct and as short as possible.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lineCounts, unifiedDiff } from "../src/diff.ts";

const text = (lines: readonly string[]) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

/** Length of the longest common subsequence, by the textbook table. */
function lcs(a: readonly string[], b: readonly string[]): number {
	const row = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		let diag = 0;
		for (let j = 1; j <= b.length; j++) {
			const up = row[j]!;
			row[j] = x === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
			diag = up;
		}
	}
	return row[b.length]!;
}

describe("unifiedDiff", () => {
	it("prints hunks with three lines of context, as git does", () => {
		const before = text(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
		const after = text(["1", "two", "3", "4", "5", "6", "7", "8", "9", "10", "eleven", "12", "13"]);
		assert.equal(
			unifiedDiff({ path: "f", before, after }),
			[
				"--- a/f",
				"+++ b/f",
				"@@ -1,5 +1,5 @@",
				" 1",
				"-2",
				"+two",
				" 3",
				" 4",
				" 5",
				"@@ -8,5 +8,6 @@",
				" 8",
				" 9",
				" 10",
				"-11",
				"+eleven",
				" 12",
				"+13",
			].join("\n"),
		);
	});

	it("joins changes up to six lines apart into one hunk", () => {
		const before = text(["a", "b", "c", "d", "e", "f", "g", "h"]);
		const after = text(["A", "b", "c", "d", "e", "f", "g", "H"]);
		assert.equal(
			unifiedDiff({ path: "f", before, after })
				.split("\n")
				.filter((l) => l.startsWith("@@")).length,
			1,
		);
	});

	it("prints new and deleted files against /dev/null, and nothing for no change", () => {
		assert.equal(unifiedDiff({ path: "n", before: null, after: "x\n" }), "--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x");
		assert.equal(
			unifiedDiff({ path: "d", before: "x\ny\n", after: null }),
			"--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y",
		);
		assert.equal(unifiedDiff({ path: "s", before: "same\n", after: "same\n" }), "--- a/s\n+++ b/s");
	});

	it("rebuilds both sides and changes as few lines as possible, on random texts", () => {
		let seed = 7;
		const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
		for (let round = 0; round < 400; round++) {
			const a = Array.from({ length: rand(14) }, () => "abcd"[rand(4)]!);
			const b = Array.from({ length: rand(14) }, () => "abcd"[rand(4)]!);
			const body = unifiedDiff({ path: "f", before: text(a), after: text(b) }, 1000)
				.split("\n")
				.slice(2)
				.filter((l) => !l.startsWith("@@"));
			if (body.length === 0) {
				assert.deepEqual(a, b, `no hunks only when nothing changed, round ${round}`);
				continue;
			}
			assert.deepEqual(
				body.filter((l) => l[0] !== "+").map((l) => l.slice(1)),
				a,
				`before, round ${round}`,
			);
			assert.deepEqual(
				body.filter((l) => l[0] !== "-").map((l) => l.slice(1)),
				b,
				`after, round ${round}`,
			);
			const { added, removed } = lineCounts({ path: "f", before: text(a), after: text(b) });
			assert.equal(added + removed, a.length + b.length - 2 * lcs(a, b), `shortest, round ${round}`);
		}
	});
});
