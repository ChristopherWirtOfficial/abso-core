// Moves (#28): a line is its id, not its place. A move gives lines a new
// parent, possibly in another file, and edits name ids, so an edit made
// before or after a move follows the moved lines.
//   PROP_SEED=<seed> PROP_CASES=1 node --test src/engine/test/moves.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Atom, type AtomId, conflicts, Graph, View } from "../index.ts";
import { StableOverlaySet } from "../state-source.ts";
import { lines, Repo, Rng } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

const BASE_SEED = Number(process.env.PROP_SEED ?? 20261004);
const CASES = Number(process.env.PROP_CASES ?? 200);

const FN = ["function area(r) {", "  const pi = 3.14;", "  return pi * r * r;", "}"];
const START = {
	"shapes.js": lines("// shapes", ...FN, "", "function other() {", "  return 1;", "}"),
	"geometry.js": lines("// geometry", "export {};"),
};
/** shapes.js with area() moved out. */
const SHAPES_AFTER = lines("// shapes", "", "function other() {", "  return 1;", "}");

/** Move area() (shapes.js lines 1-4) to the end of geometry.js. */
function moveArea(repo: Repo, against?: Iterable<AtomId>): Atom {
	return repo.draft({ move: { file: "shapes.js", start: 1, end: 5, to: "geometry.js", at: 2 } }, against);
}

function accept(repo: Repo, atom: Atom): Atom {
	repo.graph.add(atom);
	repo.shared.add(atom.id);
	return atom;
}

/** Two atoms built against the same base, both accepted: the merge. */
function concurrently(
	repo: Repo,
	a: (base: AtomId[]) => Atom,
	b: (base: AtomId[]) => Atom,
): { first: Atom; second: Atom } {
	const base = [...repo.shared];
	const first = accept(repo, a(base));
	const second = accept(repo, b(base));
	return { first, second };
}

describe("moves", () => {
	it("moves lines to another file, keeping their ids", () => {
		const repo = Repo.init(START);
		const before = repo
			.view()
			.lines("shapes.js")
			.slice(1, 5)
			.map((l) => l.id);
		accept(repo, moveArea(repo));
		assert.equal(repo.text("shapes.js"), SHAPES_AFTER);
		assert.equal(repo.text("geometry.js"), lines("// geometry", "export {};", ...FN));
		const view = repo.view();
		assert.deepEqual(
			view
				.lines("geometry.js")
				.slice(2)
				.map((l) => l.id),
			before,
		);
		assert.equal(view.fileOf(before[2]!), "geometry.js");
	});

	it("an edit made before the move, to the body, the first line or the last line, follows the moved lines", () => {
		for (const [old, now] of [
			["  return pi * r * r;", "  return pi * r ** 2;"],
			["function area(r) {", "function area(r = 1) {"],
			["}\n\nfunction other", "} // area\n\nfunction other"],
		] as const) {
			const repo = Repo.init(START);
			concurrently(
				repo,
				(base) => repo.draft({ edits: [{ file: "shapes.js", old, new: now }] }, base),
				(base) => moveArea(repo, base),
			);
			assert.deepEqual(conflicts(repo.graph, repo.shared), [], old);
			assert.equal(repo.text("shapes.js"), SHAPES_AFTER, old);
			const fn = FN.map((l) => (l === old.split("\n")[0] ? now.split("\n")[0]! : l));
			assert.equal(repo.text("geometry.js"), lines("// geometry", "export {};", ...fn), old);
		}
	});

	it("an edit made after the move, against a view without it, follows too (either order is the same set)", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) => moveArea(repo, base),
			(base) =>
				repo.draft({ edits: [{ file: "shapes.js", old: "  const pi = 3.14;", new: "  const pi = Math.PI;" }] }, base),
		);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(
			repo.text("geometry.js"),
			lines("// geometry", "export {};", "function area(r) {", "  const pi = Math.PI;", "  return pi * r * r;", "}"),
		);
	});

	it("lines inserted inside the moved block go with it", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) =>
				repo.draft(
					{
						edits: [
							{ file: "shapes.js", old: "  const pi = 3.14;\n", new: "  const pi = 3.14;\n  // area of a circle\n" },
						],
					},
					base,
				),
			(base) => moveArea(repo, base),
		);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(repo.text("shapes.js"), SHAPES_AFTER);
		assert.match(repo.text("geometry.js"), /const pi = 3\.14;\n {2}\/\/ area of a circle\n/);
	});

	it("inserting just above the moved block collides with the move: it is unclear which place the line meant", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) =>
				repo.draft({ edits: [{ file: "shapes.js", start: 1, end: 1, lines: ["/** The area of a circle. */"] }] }, base),
			(base) => moveArea(repo, base),
		);
		assert.equal(conflicts(repo.graph, repo.shared).length, 1);
	});

	it("a line deleted at its old place is deleted at its new one, with no collision", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) => repo.draft({ edits: [{ file: "shapes.js", old: `${FN.join("\n")}\n`, new: "" }] }, base),
			(base) => moveArea(repo, base),
		);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(repo.text("shapes.js"), SHAPES_AFTER);
		assert.equal(repo.text("geometry.js"), lines("// geometry", "export {};"));
	});

	it("two moves of the same lines collide", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) => moveArea(repo, base),
			(base) => repo.draft({ move: { file: "shapes.js", start: 1, end: 5, to: "shapes.js", at: 9 } }, base),
		);
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		assert.ok(found[0]!.keys.some((k) => k.key.startsWith("P:")));
	});

	it("a whole file renamed: every line moves, and an edit to it lands in the new file", () => {
		const repo = Repo.init(START);
		concurrently(
			repo,
			(base) => repo.draft({ edits: [{ file: "shapes.js", old: "  return 1;", new: "  return 2;" }] }, base),
			(base) => repo.draft({ move: { file: "shapes.js", start: 0, end: 9, to: "circle.js", at: 0 } }, base),
		);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		const view = repo.view();
		assert.equal(view.hasFile("shapes.js"), false);
		assert.equal(view.text("circle.js"), START["shapes.js"].replace("return 1;", "return 2;"));
		assert.deepEqual(view.paths(), ["circle.js", "geometry.js"]);
	});

	it("a block moved within a file, up or down, with a concurrent edit inside it", () => {
		for (const at of [0, 9]) {
			const repo = Repo.init(START);
			concurrently(
				repo,
				(base) =>
					repo.draft(
						{ edits: [{ file: "shapes.js", old: "  return pi * r * r;", new: "  return pi * r * r; // m^2" }] },
						base,
					),
				(base) => repo.draft({ move: { file: "shapes.js", start: 1, end: 5, to: "shapes.js", at } }, base),
			);
			assert.deepEqual(conflicts(repo.graph, repo.shared), []);
			const fn = lines(...FN).replace("r * r;", "r * r; // m^2");
			assert.equal(repo.text("shapes.js"), at === 0 ? fn + SHAPES_AFTER : SHAPES_AFTER + fn);
		}
	});

	it("a file split in two: edits to either part, made apart, land in the right file", () => {
		const repo = Repo.init(START);
		const base = [...repo.shared];
		accept(repo, repo.draft({ move: { file: "shapes.js", start: 5, end: 9, to: "other.js", at: 0 } }, base));
		accept(repo, repo.draft({ edits: [{ file: "shapes.js", old: "3.14", new: "Math.PI" }] }, base));
		accept(repo, repo.draft({ edits: [{ file: "shapes.js", old: "return 1;", new: "return 2;" }] }, base));
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(repo.text("shapes.js"), lines("// shapes", ...FN).replace("3.14", "Math.PI"));
		assert.equal(repo.text("other.js"), lines("", "function other() {", "  return 2;", "}"));
	});

	it("two files merged into one: the second file's lines move under the end of the first, and edits follow", () => {
		const repo = Repo.init(START);
		const base = [...repo.shared];
		accept(repo, repo.draft({ move: { file: "geometry.js", start: 0, end: 2, to: "shapes.js", at: 9 } }, base));
		accept(repo, repo.draft({ edits: [{ file: "geometry.js", old: "export {};", new: "export { area };" }] }, base));
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(repo.view().hasFile("geometry.js"), false);
		assert.equal(repo.text("shapes.js"), START["shapes.js"] + lines("// geometry", "export { area };"));
	});

	it("moves stack: a moved block can move again, and a later edit follows both", () => {
		const repo = Repo.init(START);
		accept(repo, moveArea(repo));
		repo.edit({ move: { file: "geometry.js", start: 2, end: 6, to: "circle.js", at: 0 } });
		repo.edit({ edits: [{ file: "circle.js", old: "3.14", new: "3.14159" }] });
		assert.equal(repo.text("circle.js"), lines(...FN).replace("3.14", "3.14159"));
		assert.equal(repo.text("geometry.js"), lines("// geometry", "export {};"));
		assert.equal(repo.text("shapes.js"), SHAPES_AFTER);
	});

	it("moves that loop lines into each other lose no lines", () => {
		// Hand-made: two moves made apart, each putting one line under the other.
		const repo = Repo.init({ "f.txt": lines("x", "m", "y", "n") });
		const mk = (line: string, parent: string): Atom => {
			const id = repo.graph.nextId();
			return {
				id,
				seq: repo.graph.size,
				author: "a",
				message: "loop",
				time: 0,
				inserts: [],
				deletes: [],
				writes: [`G:${parent}`, `P:${line}`],
				reads: [],
				holds: [],
				needs: [],
				resolves: [],
				reasons: [],
				deps: ["a0"],
				moves: [{ line, parent }],
			};
		};
		accept(repo, mk("a0.0", "a0.2"));
		accept(repo, mk("a0.2", "a0.0"));
		const text = repo.text("f.txt");
		assert.deepEqual(text.split("\n").filter(Boolean).sort(), ["m", "n", "x", "y"]);
		class BoundedReads extends SqlState {
			override read(collection: string, key: string): unknown {
				if (this.reads > 10_000) throw new Error("relocation cycle did not terminate");
				return super.read(collection, key);
			}
		}
		const storage = new BoundedReads();
		try {
			const stored = new Graph({ storage });
			for (let seq = 0; seq < repo.graph.size; seq++) stored.add(repo.graph.atom(repo.graph.idOfSeq(seq)));
			const reopened = new Graph({ storage });
			assert.equal(new View(reopened, repo.shared).text("f.txt"), text);
			assert.equal(new View(reopened, new StableOverlaySet(repo.shared)).text("f.txt"), text);
		} finally {
			storage.db.close();
		}
	});

	it("rejects a move onto itself or out of range", () => {
		const repo = Repo.init(START);
		assert.throws(() => repo.draft({ move: { file: "shapes.js", start: 1, end: 5, to: "shapes.js", at: 3 } }), {
			code: "bad-range",
		});
		assert.throws(() => repo.draft({ move: { file: "shapes.js", start: 1, end: 5, to: "shapes.js", at: 5 } }), {
			code: "bad-range",
		});
		assert.throws(() => repo.draft({ move: { file: "shapes.js", start: 4, end: 4, to: "x.js", at: 0 } }), {
			code: "bad-range",
		});
		assert.throws(() => repo.draft({ move: { file: "shapes.js", start: 1, end: 2, to: "geometry.js", at: 3 } }), {
			code: "bad-range",
		});
		assert.throws(
			() =>
				repo.draft({
					move: { file: "shapes.js", start: 1, end: 2, to: "x.js", at: 0 },
					edits: [{ file: "geometry.js", old: "export", new: "x" }],
				}),
			{ code: "bad-edit" },
		);
	});
});

describe("moves, property", () => {
	const word = (rng: Rng): string =>
		rng.pick(["a", "b", "c", "x", "y", "}", "", "let q = 1;", "return z;"]) +
		(rng.chance(0.5) ? String(rng.int(9)) : "");

	it("random edits and moves, one after another, agree with editing plain text", () => {
		for (let c = 0; c < CASES; c++) {
			const seed = BASE_SEED + c;
			const rng = new Rng(seed);
			const names = ["a.txt", "b.txt", "c.txt"];
			const plain: Record<string, string[]> = {};
			const files: Record<string, string> = {};
			for (const f of names.slice(0, 2)) {
				plain[f] = Array.from({ length: rng.range(1, 8) }, () => word(rng));
				files[f] = lines(...plain[f]!);
			}
			plain["c.txt"] = [];
			const repo = Repo.init(files);
			for (let step = 0; step < 12; step++) {
				const from = rng.pick(names.filter((f) => plain[f]!.length > 0));
				const n = plain[from]!.length;
				if (rng.chance(0.5)) {
					const start = rng.int(n);
					const end = rng.range(start + 1, n);
					const to = rng.pick(names);
					const len = plain[to]!.length;
					let at = rng.int(len + 1);
					if (to === from && at >= start && at <= end)
						at = start > 0 ? rng.int(start) : end < len ? rng.range(end + 1, len) : -1;
					if (at < 0) continue;
					repo.edit({ move: { file: from, start, end, to, at } });
					const block = plain[from]!.splice(start, end - start);
					const where = to === from && at > end ? at - block.length : at;
					plain[to]!.splice(where, 0, ...block);
				} else {
					const start = rng.int(n + 1);
					const end = rng.range(start, Math.min(n, start + 2));
					const add = Array.from({ length: rng.int(3) }, () => word(rng));
					if (end - start === add.length && plain[from]!.slice(start, end).every((l, i) => l === add[i])) continue;
					repo.edit({ edits: [{ file: from, start, end, lines: add }] });
					plain[from]!.splice(start, end - start, ...add);
				}
				for (const f of names) assert.equal(repo.text(f), lines(...plain[f]!), `seed ${seed}, step ${step}, ${f}`);
			}
		}
	});

	it("a move and an edit inside the moved block, made apart, compose: the edited block lands at the new place", () => {
		for (let c = 0; c < CASES; c++) {
			const seed = BASE_SEED + c;
			const rng = new Rng(seed);
			const a = Array.from({ length: rng.range(3, 10) }, (_, i) => `a${i}`);
			const b = Array.from({ length: rng.range(0, 4) }, (_, i) => `b${i}`);
			const repo = Repo.init(b.length ? { "a.txt": lines(...a), "b.txt": lines(...b) } : { "a.txt": lines(...a) });
			const start = rng.int(a.length);
			const end = rng.range(start + 1, a.length);
			const at = rng.int(b.length + 1);
			// An edit that replaces at least one line of the block, staying inside it.
			const es = rng.range(start, end - 1);
			const ee = rng.range(es + 1, end);
			const add = Array.from({ length: rng.int(3) }, (_, i) => `new${i}`);
			concurrently(
				repo,
				(base) => repo.draft({ move: { file: "a.txt", start, end, to: "b.txt", at } }, base),
				(base) => repo.draft({ edits: [{ file: "a.txt", start: es, end: ee, lines: add }] }, base),
			);
			const msg = `seed ${seed}`;
			assert.deepEqual(conflicts(repo.graph, repo.shared), [], msg);
			const block = [...a.slice(start, es), ...add, ...a.slice(ee, end)];
			assert.equal(repo.text("a.txt"), lines(...a.slice(0, start), ...a.slice(end)), msg);
			assert.equal(repo.text("b.txt"), lines(...b.slice(0, at), ...block, ...b.slice(at)), msg);
		}
	});
});
