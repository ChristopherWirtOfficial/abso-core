import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canonicalText,
	diffLines,
	type Hunk,
	joinLines,
	mergeLines,
	mergeWords,
	normalizeText,
	splitLines,
} from "../index.ts";
import { Rng } from "./helpers.ts";

describe("line text", () => {
	it("normalizes line endings", () => {
		assert.equal(normalizeText("a\r\nb\rc\n"), "a\nb\nc\n");
	});

	it("splits and joins with a trailing newline", () => {
		assert.deepEqual(splitLines(""), []);
		assert.deepEqual(splitLines("\n"), [""]);
		assert.deepEqual(splitLines("a"), ["a"]);
		assert.deepEqual(splitLines("a\n"), ["a"]);
		assert.deepEqual(splitLines("a\n\nb\n"), ["a", "", "b"]);
		assert.equal(joinLines([]), "");
		assert.equal(joinLines([""]), "\n");
		assert.equal(joinLines(["a", "b"]), "a\nb\n");
		assert.equal(canonicalText("a\r\nb"), "a\nb\n");
	});
});

/** Apply hunks to the old lines. */
function apply(a: readonly string[], hunks: readonly Hunk[]): string[] {
	const out: string[] = [];
	let pos = 0;
	for (const h of hunks) {
		out.push(...a.slice(pos, h.start), ...h.lines);
		pos = h.end;
	}
	return [...out, ...a.slice(pos)];
}

/** LCS length by plain recursion with memo (independent of the engine's table). */
function lcs(a: readonly string[], b: readonly string[]): number {
	const memo = new Map<string, number>();
	const go = (i: number, j: number): number => {
		if (i === a.length || j === b.length) return 0;
		const key = `${i},${j}`;
		const hit = memo.get(key);
		if (hit !== undefined) return hit;
		const v = a[i] === b[j] ? 1 + go(i + 1, j + 1) : Math.max(go(i + 1, j), go(i, j + 1));
		memo.set(key, v);
		return v;
	};
	return go(0, 0);
}

describe("diffLines", () => {
	it("finds a single replaced line", () => {
		assert.deepEqual(diffLines(["a", "b", "c"], ["a", "X", "c"]), [{ start: 1, end: 2, lines: ["X"] }]);
	});

	it("keeps an unchanged line between two changes as two hunks", () => {
		assert.deepEqual(diffLines(["a", "b", "c"], ["X", "b", "Y"]), [
			{ start: 0, end: 1, lines: ["X"] },
			{ start: 2, end: 3, lines: ["Y"] },
		]);
	});

	it("reports pure insertions and pure deletions", () => {
		assert.deepEqual(diffLines(["a", "c"], ["a", "b", "c"]), [{ start: 1, end: 1, lines: ["b"] }]);
		assert.deepEqual(diffLines(["a", "b", "c"], ["a", "c"]), [{ start: 1, end: 2, lines: [] }]);
		assert.deepEqual(diffLines([], ["x"]), [{ start: 0, end: 0, lines: ["x"] }]);
		assert.deepEqual(diffLines(["x"], []), [{ start: 0, end: 1, lines: [] }]);
		assert.deepEqual(diffLines(["x"], ["x"]), []);
	});

	it("random inputs: hunks are ordered, disjoint, rebuild the new lines, and keep a longest common subsequence", () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const rng = new Rng(seed);
			const alphabet = ["a", "b", "c", "d", "", "e", "f", "g"].slice(0, rng.range(1, 8));
			const size = seed <= 1500 ? 9 : 40;
			const a = Array.from({ length: rng.int(size) }, () => rng.pick(alphabet));
			const b = Array.from({ length: rng.int(size) }, () => rng.pick(alphabet));
			const hunks = diffLines(a, b);
			const where = `seed ${seed}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`;
			assert.deepEqual(apply(a, hunks), b, where);
			let pos = 0;
			let kept = a.length;
			for (const h of hunks) {
				assert.ok(h.start >= pos && h.end >= h.start, where);
				assert.ok(h.end > h.start || h.lines.length > 0, `empty hunk at ${where}`);
				pos = h.end;
				kept -= h.end - h.start;
			}
			assert.equal(kept, lcs(a, b), `not minimal at ${where}`);
		}
	});

	it("stays minimal at any size: four small changes to 2100 lines are four hunks", () => {
		const a = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
		const b = [...a];
		b[0] = "FIRST";
		b[1500] = "MIDDLE";
		b[2099] = "LAST";
		b.splice(700, 0, "inserted");
		assert.deepEqual(diffLines(a, b), [
			{ start: 0, end: 1, lines: ["FIRST"] },
			{ start: 700, end: 700, lines: ["inserted"] },
			{ start: 1500, end: 1501, lines: ["MIDDLE"] },
			{ start: 2099, end: 2100, lines: ["LAST"] },
		]);
		// Wholly different texts are one hunk, found at once.
		assert.deepEqual(
			diffLines(
				a,
				a.map((s) => `${s}!`),
			),
			[{ start: 0, end: 2100, lines: a.map((s) => `${s}!`) }],
		);
	});

	it("stays minimal past the cost cap: 2,091 scattered changes and 622 inserts in 23,000 lines", () => {
		const a = Array.from({ length: 23000 }, (_, i) => `line ${i}`);
		const b = [...a];
		let changed = 0;
		for (let i = 0; i < b.length; i += 11, changed++) b[i] = `changed ${i}`;
		for (let i = b.length; i > 0; i -= 37) b.splice(i, 0, `new ${i}`);
		const hunks = diffLines(a, b);
		assert.deepEqual(apply(a, hunks), b);
		assert.equal(a.length - hunks.reduce((n, h) => n + h.end - h.start, 0), a.length - changed);
	});

	it("a file reordered through is close to minimal and quick, not its length squared (abso issue 158)", () => {
		const a = Array.from({ length: 23000 }, (_, i) => `line ${i}`);
		const b = [...a].reverse();
		const t0 = performance.now();
		const hunks = diffLines(a, b);
		assert.ok(performance.now() - t0 < 2000, "under 2 s (minimal Myers took about 10 s)");
		assert.deepEqual(apply(a, hunks), b);
	});
});

describe("mergeLines", () => {
	const m = (b: string, o: string, t: string) => mergeLines(b.split(" "), o.split(" "), t.split(" "));
	it("takes one-sided changes from either side", () => {
		assert.deepEqual(m("a b c d", "a B c d", "a b c D"), {
			lines: ["a", "B", "c", "D"],
			conflicts: 0,
			resolved: [],
			conflictsAt: [],
		});
	});
	it("takes identical changes on both sides once", () => {
		assert.deepEqual(m("a b c d e", "a X c d E", "a X c d e"), {
			lines: ["a", "X", "c", "d", "E"],
			conflicts: 0,
			resolved: [],
			conflictsAt: [],
		});
		assert.deepEqual(m("a b", "a n b", "a n b"), {
			lines: ["a", "n", "b"],
			conflicts: 0,
			resolved: [],
			conflictsAt: [],
		});
	});
	it("counts differing or touching changes as conflicts", () => {
		assert.equal(m("a b c", "a X c", "a Y c").conflicts, 1);
		assert.equal(m("a b c d", "a X c d", "a b Y d").conflicts, 1);
		assert.equal(m("a b", "a x b", "a y b").conflicts, 1);
	});
	it("hands a conflict to the caller with where each side starts, and writes what it returns (#11)", () => {
		const seen: unknown[] = [];
		const got = mergeLines("a b c d".split(" "), "a n b X d".split(" "), "a b Y d".split(" "), undefined, (c) => {
			seen.push(c);
			return ["<", ...c.ours, "|", ...c.base, "=", ...c.theirs, ">"];
		});
		assert.deepEqual(seen, [{ base: ["c"], ours: ["X"], theirs: ["Y"], baseAt: 2, oursAt: 3, theirsAt: 2 }]);
		assert.deepEqual(got, {
			lines: ["a", "n", "b", "<", "X", "|", "c", "=", "Y", ">", "d"],
			conflicts: 1,
			resolved: [],
			conflictsAt: [{ at: 3, length: 7 }],
		});
	});
	it("agrees with taking every change when nothing overlaps (random)", () => {
		for (let seed = 0; seed < 300; seed++) {
			let s = seed * 7919 + 1;
			const rnd = (n: number) => (s = (s * 1103515245 + 12345) % 2147483648) % n;
			const base = Array.from({ length: 6 + rnd(10) }, (_, k) => `l${k}`);
			// ours edits the first half, theirs the second, with a gap between.
			const cut = Math.floor(base.length / 2);
			const ours = base.map((l, k) => (k < cut - 1 && rnd(3) === 0 ? `${l}o` : l));
			const theirs = base.map((l, k) => (k > cut && rnd(3) === 0 ? `${l}t` : l));
			const expected = base.map((l, k) => (ours[k] !== l ? ours[k] : theirs[k]));
			const got = mergeLines(base, ours, theirs);
			if (got.conflicts === 0) assert.deepEqual(got.lines, expected, `seed ${seed}`);
			// Adjacent edits from both sides may touch and conflict; nothing else may.
			else
				assert.ok(
					ours.some((l, k) => l !== base[k] && (theirs[k + 1] !== base[k + 1] || theirs[k - 1] !== base[k - 1])),
					`seed ${seed}`,
				);
		}
	});
});

describe("mergeWords", () => {
	it("keeps items both sides added to the same list on one line, theirs first", () => {
		assert.equal(
			mergeWords("const S = [a, b, c];", "const S = [a, b, c, d];", "const S = [a, b, c, e];"),
			"const S = [a, b, c, e, d];",
		);
		assert.equal(
			mergeWords('import { a } from "x";', 'import { a, b } from "x";', 'import { a, c } from "x";'),
			'import { a, c, b } from "x";',
		);
		assert.equal(
			mergeWords("const o = { a: 1 };", "const o = { a: 1, b: 2 };", "const o = { a: 1, c: [3] };"),
			"const o = { a: 1, c: [3], b: 2 };",
		);
	});
	it("takes one-sided and identical word changes", () => {
		assert.equal(
			mergeWords("x = [a, b]; y = 1;", "x = [a, b, c]; y = 1;", "x = [a, b]; y = 2;"),
			"x = [a, b, c]; y = 2;",
		);
		assert.equal(mergeWords("[a]", "[a, b]", "[a, b]"), "[a, b]");
	});
	it("is no merge for call arguments, method chains, or overlapping changes", () => {
		assert.equal(mergeWords("f(a);", "f(a, x);", "f(a, y);"), undefined);
		assert.equal(mergeWords("return h2;", "return h2.toLowerCase();", "return h2.trim();"), undefined);
		assert.equal(mergeWords("[a, b]", "[a, X]", "[a, Y]"), undefined);
	});
});
