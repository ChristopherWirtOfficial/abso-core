import assert from "node:assert/strict";
import { it } from "node:test";
import { diffChunkedLines, diffLineStream, diffLines } from "../text.ts";

it("reads aligned long lines once without accepting hash collisions", () => {
	const before = ["x".repeat(100000), "reqicjpk", "y".repeat(80000)];
	const after = [before[0]!, "ejfslztg", before[2]!];
	const reads = [0, 0, 0];
	const sources = before.map(
		(line, index) =>
			function* () {
				reads[index]!++;
				for (let at = 0; at < line.length; at += 4) yield line.slice(at, at + 4);
			},
	);
	assert.deepEqual(diffChunkedLines(sources, after), diffLines(before, after));
	assert.equal(reads[0], 1);
	assert.equal(reads[2], 1);
});

it("preserves exact array-diff hunks for single-pass line sources", () => {
	let seed = 918273;
	const random = (n: number) => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % n;
	};
	for (let trial = 0; trial < 3000; trial++) {
		const before = Array.from({ length: random(90) }, () => `line ${random(19)}`);
		const after = Array.from({ length: random(90) }, () => `line ${random(19)}`);
		let reads = 0;
		function* oldLines() {
			for (const line of before) {
				reads++;
				yield line;
			}
		}
		assert.deepEqual(diffLineStream(oldLines(), after), diffLines(before, after));
		assert.deepEqual(
			diffChunkedLines(
				before.map((line) => () => [line.slice(0, 3), line.slice(3)]),
				after,
			),
			diffLines(before, after),
		);
		assert.equal(reads, before.length);
	}
});

it("preserves prefix, suffix and expensive-rewrite fallback choices", () => {
	for (const count of [0, 1, 300, 900]) {
		const before = Array.from({ length: count }, (_, i) => `old ${i}`);
		const after = [...before].reverse();
		before.unshift("prefix");
		after.unshift("prefix");
		before.push("suffix");
		after.push("suffix");
		assert.deepEqual(diffLineStream(before.values(), after), diffLines(before, after));
	}
});

it("compares chunked lines exactly, including a same-length hash collision", () => {
	const before = ["reqicjpk", "", "x".repeat(100000), "\ud800\udc00"];
	const after = ["ejfslztg", "", "x".repeat(100000), "\ud800\udc00", "end"];
	for (const size of [1, 7, 16384]) {
		const sources = before.map(
			(line) =>
				function* () {
					for (let offset = 0; offset < line.length; offset += size) yield line.slice(offset, offset + size);
				},
		);
		assert.deepEqual(diffChunkedLines(sources, after), diffLines(before, after));
	}
});

it("reads single-chunk old lines once while matching exactly", () => {
	let reads = 0;
	const before = ["keep", "replace", ""];
	const sources = before.map(
		(line) =>
			function* () {
				reads++;
				yield line;
			},
	);
	assert.deepEqual(diffChunkedLines(sources, ["keep", "new", ""]), diffLines(before, ["keep", "new", ""]));
	assert.equal(reads, before.length);
});
