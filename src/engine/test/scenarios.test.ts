// The nine scenarios from the June 2026 conversation (docs/prototype.md,
// "Tests the prototype must have").

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Atom,
	type AtomInput,
	buildAtom,
	conflicts,
	drop,
	Graph,
	gapKey,
	history,
	labelContents,
	lineKey,
	project,
	reslice,
	unresolvedConflicts,
	View,
} from "../index.ts";
import { lines, Repo } from "./helpers.ts";

const SIDEBAR = lines(
	"import { useState } from 'react';",
	"import { Panel } from './Panel';",
	"",
	"export function Sidebar() {",
	"  return (",
	'    <aside className="sidebar">',
	"      <Panel />",
	"    </aside>",
	"  );",
	"}",
);

describe("1. sidebar rail", () => {
	const repo = Repo.init({ "Panel.tsx": lines("export function Panel() {}"), "Sidebar.tsx": SIDEBAR });
	const rail = repo.edit({
		message: "add the draggable rail component",
		edits: [
			{ file: "Rail.tsx", old: "", new: lines("export function Rail() {", '  return <div className="rail" />;', "}") },
		],
	});
	const importInput = [
		{
			file: "Sidebar.tsx",
			old: "import { Panel } from './Panel';\n",
			new: "import { Panel } from './Panel';\nimport { Rail } from './Rail';\n",
		},
	];
	const importRail = repo.edit({ message: "import Rail into the sidebar", edits: importInput });
	const placeInput: AtomInput = {
		author: "agent",
		message: "place the rail after the panel",
		edits: [{ file: "Sidebar.tsx", old: "      <Panel />\n", new: "      <Panel />\n      <Rail />\n" }],
	};
	const placeTextOnly = buildAtom(repo.view(), placeInput);
	const placeWithReason = buildAtom(repo.view(), {
		...placeInput,
		reasons: [{ to: importRail.id, kind: "because-of", text: "the import exists because the rail is placed here" }],
	});
	const place = repo.edit({
		...placeInput,
		reasons: [{ to: importRail.id, kind: "because-of", text: "the import exists because the rail is placed here" }],
		needs: [importRail.id],
	});
	const width = repo.edit({
		message: "track the sidebar width",
		edits: [
			{
				file: "Sidebar.tsx",
				old: "export function Sidebar() {\n",
				new: "export function Sidebar() {\n  const [width, setWidth] = useState(240);\n",
			},
		],
	});

	it("creating a file depends on nothing", () => {
		assert.deepEqual(rail.deps, []);
		assert.deepEqual(rail.writes, [gapKey("^Rail.tsx")]);
		assert.deepEqual(rail.reads, []);
		assert.deepEqual([...repo.graph.closure(rail.id)], [rail.id]);
	});

	it("the import depends only on the lines it sits between, not on the new file", () => {
		const panelImport = repo.lineId("Sidebar.tsx", "import { Panel } from './Panel';");
		const blank = repo.lineId("Sidebar.tsx", "");
		assert.deepEqual(importRail.deps, ["a0"]);
		assert.deepEqual(importRail.writes, [gapKey(panelImport)]);
		assert.deepEqual(importRail.reads, [lineKey(panelImport), lineKey(blank)].sort());
		assert.ok(!repo.graph.closure(importRail.id).has(rail.id));
	});

	it("placing the rail does not textually need the import", () => {
		assert.deepEqual(placeTextOnly.deps, ["a0"]);
		// Accepted on its own, its closure renders <Rail /> without importing it.
		const bare = Repo.init({ "Panel.tsx": lines("export function Panel() {}"), "Sidebar.tsx": SIDEBAR });
		bare.edit({ message: "import Rail", edits: importInput });
		const placed = bare.edit(placeInput);
		const alone = new View(bare.graph, bare.graph.closure(placed.id)).text("Sidebar.tsx");
		assert.ok(alone.includes("<Rail />"));
		assert.ok(!alone.includes("import { Rail }"));
		assert.ok(bare.text("Sidebar.tsx").includes("import { Rail }"));
	});

	it("a because-of reason alone is not a dependency; reason plus needs puts the import in the closure", () => {
		assert.deepEqual(placeWithReason.deps, ["a0"]);
		assert.deepEqual(place.deps, ["a0", importRail.id]);
		assert.ok(repo.graph.closure(place.id).has(importRail.id));
		assert.deepEqual(place.reasons, [
			{ to: importRail.id, kind: "because-of", text: "the import exists because the rail is placed here" },
		]);
	});

	it("the width state depends only on the base", () => {
		assert.deepEqual(width.deps, ["a0"]);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
	});

	it("the shared projection has every piece in place", () => {
		assert.equal(
			repo.text("Sidebar.tsx"),
			lines(
				"import { useState } from 'react';",
				"import { Panel } from './Panel';",
				"import { Rail } from './Rail';",
				"",
				"export function Sidebar() {",
				"  const [width, setWidth] = useState(240);",
				"  return (",
				'    <aside className="sidebar">',
				"      <Panel />",
				"      <Rail />",
				"    </aside>",
				"  );",
				"}",
			),
		);
		assert.equal(repo.text("Rail.tsx"), lines("export function Rail() {", '  return <div className="rail" />;', "}"));
	});
});

describe("2. two imports", () => {
	const BASE = lines(
		"import { Panel } from './Panel';",
		"import { Header } from './Header';",
		"import { OldFooter } from './OldFooter';",
		"",
		"export function Sidebar() {}",
	);
	const RAIL = "import { Rail } from './Rail';";
	const FOOTER = "import { Footer } from './Footer';";
	const PANEL = "import { Panel } from './Panel';";
	const HEADER = "import { Header } from './Header';";
	const OLD_FOOTER = "import { OldFooter } from './OldFooter';";

	type Spec = Omit<AtomInput, "author" | "message" | "time"> & { author: string; message: string };

	/** Build both atoms against the base, accepted in the given order. */
	function concurrently(first: Spec, second: Spec): { repo: Repo; a: Atom; b: Atom } {
		const repo = Repo.init({ "Sidebar.tsx": BASE });
		const a = repo.edit(first, ["a0"]);
		const b = repo.edit(second, ["a0"]);
		return { repo, a, b };
	}
	const insertAfter = (anchor: string, line: string, mode: "both" | "after" = "both") => ({
		file: "Sidebar.tsx",
		old: `${anchor}\n`,
		new: `${anchor}\n${line}\n`,
		mode,
	});
	const railAfter = (anchor: string, mode: "both" | "after" = "both"): Spec => ({
		author: "rail-agent",
		message: "import Rail for the draggable rail",
		edits: [insertAfter(anchor, RAIL, mode)],
	});
	const footerAfter = (anchor: string, mode: "both" | "after" = "both"): Spec => ({
		author: "footer-agent",
		message: "import Footer for the new footer",
		edits: [insertAfter(anchor, FOOTER, mode)],
	});
	const footerReplacesOld: Spec = {
		author: "footer-agent",
		message: "replace the old footer with the new one",
		edits: [{ file: "Sidebar.tsx", old: OLD_FOOTER, new: FOOTER }],
	};

	it("different neighbours: no conflict, same bytes in either acceptance order", () => {
		const one = concurrently(railAfter(PANEL), footerAfter(HEADER));
		const two = concurrently(footerAfter(HEADER), railAfter(PANEL));
		assert.deepEqual(conflicts(one.repo.graph, one.repo.shared), []);
		assert.deepEqual(conflicts(two.repo.graph, two.repo.shared), []);
		const expected = lines(PANEL, RAIL, HEADER, FOOTER, OLD_FOOTER, "", "export function Sidebar() {}");
		assert.equal(one.repo.text("Sidebar.tsx"), expected);
		assert.equal(two.repo.text("Sidebar.tsx"), expected);
	});

	it("after mode: the rail doesn't claim its south neighbour, so replacing that line doesn't conflict", () => {
		const one = concurrently(railAfter(HEADER, "after"), footerReplacesOld);
		const two = concurrently(footerReplacesOld, railAfter(HEADER, "after"));
		assert.deepEqual(conflicts(one.repo.graph, one.repo.shared), []);
		assert.deepEqual(conflicts(two.repo.graph, two.repo.shared), []);
		const expected = lines(PANEL, HEADER, RAIL, FOOTER, "", "export function Sidebar() {}");
		assert.equal(one.repo.text("Sidebar.tsx"), expected);
		assert.equal(two.repo.text("Sidebar.tsx"), expected);
	});

	it("the same pair in both mode conflicts: the rail relied on the line below it", () => {
		const { repo, a, b } = concurrently(railAfter(HEADER, "both"), footerReplacesOld);
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		const c = found[0]!;
		assert.deepEqual(c.atoms, [a.id, b.id]);
		assert.equal(c.kind, "edit-edit");
		const oldFooterLine = repo.lineId("Sidebar.tsx", OLD_FOOTER, ["a0"]);
		assert.deepEqual(c.keys, [{ key: lineKey(oldFooterLine), writer: b.id, other: a.id, relation: "read" }]);
	});

	it("both inserting into the same gap in both mode conflict; a third atom resolves it with both reasons visible", () => {
		const { repo, a, b } = concurrently(railAfter(HEADER), footerAfter(HEADER));
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		const c = found[0]!;
		assert.equal(c.kind, "edit-edit");
		const headerLine = repo.lineId("Sidebar.tsx", HEADER);
		assert.deepEqual(c.keys, [{ key: gapKey(headerLine), writer: a.id, other: b.id, relation: "write" }]);
		assert.deepEqual(c.sides, [
			{ atom: a.id, author: "rail-agent", message: "import Rail for the draggable rail" },
			{ atom: b.id, author: "footer-agent", message: "import Footer for the new footer" },
		]);
		assert.deepEqual(c.resolvedBy, []);

		// A conflicted set still projects deterministically: the higher priority run comes first.
		const merged = repo.text("Sidebar.tsx");
		assert.equal(merged, lines(PANEL, HEADER, FOOTER, RAIL, OLD_FOOTER, "", "export function Sidebar() {}"));

		// The resolver sees both sides and orders them on purpose.
		const resolver = repo.edit({
			author: "reviewer",
			message: "keep both imports, Rail before Footer",
			resolves: [a.id, b.id],
			edits: [{ file: "Sidebar.tsx", old: `${FOOTER}\n${RAIL}\n`, new: `${RAIL}\n${FOOTER}\n` }],
		});
		assert.deepEqual(
			resolver.deps.filter((d) => d === a.id || d === b.id),
			[a.id, b.id],
		);
		const after = conflicts(repo.graph, repo.shared);
		assert.equal(after.length, 1);
		assert.deepEqual(after[0]!.resolvedBy, [resolver.id]);
		assert.deepEqual(unresolvedConflicts(repo.graph, repo.shared), []);
		assert.equal(
			repo.text("Sidebar.tsx"),
			lines(PANEL, HEADER, RAIL, FOOTER, OLD_FOOTER, "", "export function Sidebar() {}"),
		);
	});

	it("two after-mode inserts into the same gap also conflict (both claim the slot right after X)", () => {
		const { repo } = concurrently(railAfter(HEADER, "after"), footerAfter(HEADER, "after"));
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.keys[0]!.key, gapKey(repo.lineId("Sidebar.tsx", HEADER)));
	});

	// June: "you maybe even claim your neighbor to the south or your neighbor to the north".
	it("before mode claims only the south neighbour: an append above a closing bracket commutes with editing the last item", () => {
		const LIST = lines("const items = [", "  a,", "  b,", "  c,", "];");
		const append: Spec = {
			author: "append-agent",
			message: "add d at the end",
			edits: [{ file: "list.ts", start: 4, end: 4, lines: ["  d,"], mode: "before" }],
		};
		const upper: Spec = {
			author: "case-agent",
			message: "c is upper case",
			edits: [{ file: "list.ts", old: "  c,", new: "  C," }],
		};
		for (const order of [
			[append, upper],
			[upper, append],
		]) {
			const repo = Repo.init({ "list.ts": LIST });
			for (const input of order) repo.edit(input, ["a0"]);
			assert.deepEqual(conflicts(repo.graph, repo.shared), []);
			assert.equal(repo.text("list.ts"), lines("const items = [", "  a,", "  b,", "  C,", "  d,", "];"));
		}
		// In both or after mode the append reads "  c," and the pair conflicts.
		for (const mode of ["both", "after"] as const) {
			const repo = Repo.init({ "list.ts": LIST });
			repo.edit({ ...append, edits: [{ ...append.edits![0]!, mode }] }, ["a0"]);
			repo.edit(upper, ["a0"]);
			assert.equal(conflicts(repo.graph, repo.shared).length, 1, mode);
		}
		// Two appends before the same bracket still conflict: both claim the gap.
		const repo = Repo.init({ "list.ts": LIST });
		repo.edit(append, ["a0"]);
		repo.edit(
			{
				...append,
				author: "other-agent",
				edits: [{ file: "list.ts", start: 4, end: 4, lines: ["  e,"], mode: "before" }],
			},
			["a0"],
		);
		assert.equal(conflicts(repo.graph, repo.shared).length, 1);
	});

	it("live, a later edit to the last item lands above an earlier before-mode append without depending on it", () => {
		const repo = Repo.init({ "list.ts": lines("const items = [", "  a,", "];") });
		const append = repo.edit({ edits: [{ file: "list.ts", start: 2, end: 2, lines: ["  b,"], mode: "before" }] });
		const draft = repo.draft({ edits: [{ file: "list.ts", old: "  a,", new: "  A," }] });
		assert.deepEqual(draft.deps, ["a0"]);
		assert.deepEqual(repo.check(draft).conflicts, []);
		repo.edit({ edits: [{ file: "list.ts", old: "  a,", new: "  A," }] });
		assert.equal(repo.text("list.ts"), lines("const items = [", "  A,", "  b,", "];"));
		assert.equal(repo.text("list.ts", repo.graph.closure(append.id)), lines("const items = [", "  a,", "  b,", "];"));
	});
});

describe("3. rename against body edit", () => {
	const DRAG = lines("export function handleDrag(e: PointerEvent) {", "  const x = e.clientX;", "  return x;", "}");
	const body: Omit<AtomInput, "author" | "time"> & { author: string } = {
		author: "body-agent",
		message: "subtract the rail offset",
		edits: [{ file: "drag.ts", old: "e.clientX;", new: "e.clientX - offset;" }],
	};
	const rename = {
		author: "rename-agent",
		message: "rename handleDrag to onDrag",
		edits: [{ file: "drag.ts", old: "function handleDrag(", new: "function onDrag(" }],
	};

	it("don't conflict textually", () => {
		const repo = Repo.init({ "drag.ts": DRAG });
		repo.edit(body, ["a0"]);
		repo.edit(rename, ["a0"]);
		assert.deepEqual(conflicts(repo.graph, repo.shared), []);
		assert.equal(
			repo.text("drag.ts"),
			lines("export function onDrag(e: PointerEvent) {", "  const x = e.clientX - offset;", "  return x;", "}"),
		);
	});

	it('conflict as "semantic" when the body edit relies on the signature line', () => {
		const repo = Repo.init({ "drag.ts": DRAG });
		const a = repo.edit({ ...body, reliesOn: [{ file: "drag.ts", start: 0, end: 1 }] }, ["a0"]);
		const b = repo.edit(rename, ["a0"]);
		const sig = repo.lineId("drag.ts", "export function handleDrag(e: PointerEvent) {", ["a0"]);
		assert.deepEqual(a.holds, [lineKey(sig)]);
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.kind, "semantic");
		assert.deepEqual(found[0]!.keys, [{ key: lineKey(sig), writer: b.id, other: a.id, relation: "hold" }]);
		assert.equal(found[0]!.sides[0].message, "subtract the rail offset");
		assert.equal(found[0]!.sides[1].author, "rename-agent");
	});

	it("live: a rename after the body edit is caught too, and needing the body edit releases it", () => {
		const repo = Repo.init({ "drag.ts": DRAG });
		const a = repo.edit({ ...body, reliesOn: [{ file: "drag.ts", start: 0, end: 1 }] });
		const draft = repo.draft(rename);
		// The rename doesn't depend on the body edit (nothing it touched is the body edit's).
		assert.deepEqual(draft.deps, ["a0"]);
		const report = repo.check(draft);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.kind, "semantic");
		assert.equal(report.conflicts[0]!.sides[0].atom, a.id);
		assert.deepEqual(repo.check(repo.draft({ ...rename, needs: [a.id] })).conflicts, []);
	});

	it("live: a body line inserted under the signature, relying on it, catches a rename that has to depend on it", () => {
		const repo = Repo.init({ "drag.ts": DRAG });
		const guard = repo.edit({
			author: "body-agent",
			message: "ignore drags without a target",
			edits: [{ file: "drag.ts", start: 1, end: 1, lines: ["  if (!e.target) return 0;"] }],
			reliesOn: [{ file: "drag.ts", start: 0, end: 1 }],
		});
		// The new signature must land above the guard, which hangs off the old
		// signature, so the rename depends on the guard; that alone doesn't
		// release the guard's hold on the signature.
		const draft = repo.draft(rename);
		assert.ok(draft.deps.includes(guard.id));
		const report = repo.check(draft);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.kind, "semantic");
		assert.deepEqual(report.conflicts[0]!.atoms, [guard.id, draft.id]);
		// Accepted anyway (--allow-conflict), the set reports the same conflict.
		repo.edit(rename);
		assert.deepEqual(
			conflicts(repo.graph, repo.shared).map((c) => [c.atoms, c.kind]),
			[[[guard.id, draft.id], "semantic"]],
		);
		assert.equal(
			repo.text("drag.ts"),
			lines(
				"export function onDrag(e: PointerEvent) {",
				"  if (!e.target) return 0;",
				"  const x = e.clientX;",
				"  return x;",
				"}",
			),
		);
	});
});

describe("4. remote reliance", () => {
	const GEOMETRY = lines("export function getOffset(rect: DOMRect) {", "  return rect.left;", "}");
	const SIDE = lines("export function place(rect: DOMRect) {", "  return 0;", "}");
	const usesOffset = {
		author: "sidebar-agent",
		message: "position the rail with getOffset (pixels)",
		edits: [{ file: "Sidebar.tsx", old: "  return 0;", new: "  return getOffset(rect) + 4;" }],
		reliesOn: [{ file: "geometry.ts", start: 1, end: 2 }],
	};
	const changesReturn = {
		author: "geometry-agent",
		message: "getOffset returns a ratio now",
		edits: [{ file: "geometry.ts", old: "return rect.left;", new: "return rect.left / rect.width;" }],
	};

	it("a change to the relied-on line in another file is a conflict", () => {
		const repo = Repo.init({ "geometry.ts": GEOMETRY, "Sidebar.tsx": SIDE });
		const a = repo.edit(usesOffset, ["a0"]);
		const b = repo.edit(changesReturn, ["a0"]);
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.kind, "semantic");
		assert.deepEqual(found[0]!.atoms, [a.id, b.id]);
		assert.equal(found[0]!.keys[0]!.relation, "hold");
	});

	it("live: the later edit is reported before acceptance; needing the reliance clears it", () => {
		const repo = Repo.init({ "geometry.ts": GEOMETRY, "Sidebar.tsx": SIDE });
		const a = repo.edit(usesOffset);
		const draft = repo.draft(changesReturn);
		const report = repo.check(draft);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.kind, "semantic");
		assert.deepEqual(report.conflicts[0]!.sides[0], {
			atom: a.id,
			author: "sidebar-agent",
			message: usesOffset.message,
		});
		assert.deepEqual(
			report.touches.map((t) => t.atom),
			["a0"],
		);

		const onTop = repo.draft({ ...changesReturn, needs: [a.id] });
		assert.deepEqual(repo.check(onTop).conflicts, []);
	});

	it("live: an unrelated edit next to the holder's own change does not release its remote hold", () => {
		const repo = Repo.init({
			"geometry.ts": GEOMETRY,
			"Sidebar.tsx": lines("const gap = 4;", "const left = 0;"),
		});
		const holder = repo.edit({
			author: "sidebar-agent",
			message: "position the rail with getOffset (pixels)",
			edits: [{ file: "Sidebar.tsx", old: "const left = 0;", new: "const left = getOffset(rect) + gap;" }],
			reliesOn: [{ file: "geometry.ts", start: 1, end: 2 }],
		});
		const ratio = changesReturn.edits[0]!;
		assert.equal(repo.check(repo.draft({ edits: [ratio] })).conflicts.length, 1);
		// The same change plus an edit to the line above the holder's edit.
		const both = repo.draft({
			author: "geometry-agent",
			message: "ratios, and a wider gap",
			edits: [ratio, { file: "Sidebar.tsx", old: "gap = 4", new: "gap = 8" }],
		});
		assert.deepEqual(both.deps, ["a0"]);
		const report = repo.check(both);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.sides[0].atom, holder.id);
	});

	// June: "you anchor the semantic claim to the definition's lines, and any edit landing in that span trips it."
	it("relying on a whole function catches a line inserted inside it", () => {
		const repo = Repo.init({
			"geometry.ts": lines(
				"export function getOffset(rect: DOMRect) {",
				"  const left = rect.left;",
				"  return left;",
				"}",
			),
			"Sidebar.tsx": lines("const left = 0;"),
		});
		const a = repo.edit(
			{
				author: "sidebar-agent",
				message: "position the rail with getOffset (pixels)",
				edits: [{ file: "Sidebar.tsx", old: "= 0", new: "= getOffset(rect)" }],
				reliesOn: [{ file: "geometry.ts", start: 0, end: 4 }],
			},
			["a0"],
		);
		const b = repo.edit(
			{
				author: "geometry-agent",
				message: "return a ratio when the rect has a width",
				edits: [
					{
						file: "geometry.ts",
						start: 2,
						end: 2,
						lines: ["  if (rect.width) return left / rect.width;"],
						mode: "after",
					},
				],
			},
			["a0"],
		);
		const found = conflicts(repo.graph, repo.shared);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.kind, "semantic");
		assert.deepEqual(found[0]!.keys, [
			{
				key: gapKey(repo.lineId("geometry.ts", "  const left = rect.left;")),
				writer: b.id,
				other: a.id,
				relation: "hold",
			},
		]);
	});
});

describe("5. file1 -> file2 -> file3 -> file1 again", () => {
	const repo = Repo.init({
		"file1.ts": lines('export const unit = "px";', "export const scale = 1;"),
		"file2.ts": lines("export const width = 10;"),
		"file3.ts": lines("export const height = 10;"),
		"file4.ts": lines("export const unrelated = true;"),
	});
	const one = repo.edit({ message: "file1: switch units", edits: [{ file: "file1.ts", old: '"px"', new: '"rem"' }] });
	const two = repo.edit({
		message: "file2: width in rem",
		edits: [{ file: "file2.ts", old: "10;", new: "0.625;" }],
		needs: [one.id],
		reasons: [{ to: one.id, kind: "because-of", text: "units changed" }],
	});
	const three = repo.edit({
		message: "file3: height in rem",
		edits: [{ file: "file3.ts", old: "10;", new: "0.625;" }],
		needs: [two.id],
	});
	const again = repo.edit({
		message: "file1: scale follows the new sizes",
		edits: [{ file: "file1.ts", old: '"rem";\nexport const scale = 1;', new: '"rem";\nexport const scale = 16;' }],
		needs: [three.id],
	});
	const unrelated = repo.edit({
		message: "file4: unrelated flag",
		edits: [{ file: "file4.ts", old: "true", new: "false" }],
	});

	it("the second file1 change is its own atom, ordered after file3 by dependencies alone", () => {
		assert.notEqual(again.id, one.id);
		assert.deepEqual(
			[one, two, three, again, unrelated].map((a) => repo.graph.lamport(a.id)),
			[1, 2, 3, 4, 1],
		);
		assert.ok(repo.graph.closure(again.id).has(three.id));
		assert.ok(!repo.graph.closure(one.id).has(again.id));
		// The unrelated atom was accepted last but sorts before file2's: history is read off deps.
		assert.deepEqual(
			history(repo.graph, repo.shared).map((a) => a.id),
			["a0", one.id, unrelated.id, two.id, three.id, again.id],
		);
	});

	it("file3's closure shows file1 as the first pass left it", () => {
		const files = project(repo.graph, repo.graph.closure(three.id));
		assert.equal(files["file1.ts"], lines('export const unit = "rem";', "export const scale = 1;"));
		assert.equal(repo.text("file1.ts"), lines('export const unit = "rem";', "export const scale = 16;"));
	});
});

describe("6. claim-only atom", () => {
	const FILE = lines(
		"function render() {",
		"  const a = 1;",
		"  const b = 2;",
		"  const c = 3;",
		"  return a + b + c;",
		"}",
		"export { render };",
	);
	const setup = (): { repo: Repo; claim: Atom } => {
		const repo = Repo.init({ "render.ts": FILE });
		const claim = repo.edit({
			author: "refactor-agent",
			message: "about to restructure the body of render",
			spans: [{ file: "render.ts", start: 1, end: 5 }],
		});
		return { repo, claim };
	};

	it("holds the lines and the gaps between them, and depends on their writer", () => {
		const { repo, claim } = setup();
		const ids = repo
			.view()
			.lines("render.ts")
			.slice(1, 5)
			.map((l) => l.id);
		assert.deepEqual(claim.inserts, []);
		assert.deepEqual(claim.deletes, []);
		assert.deepEqual(claim.writes, []);
		assert.deepEqual(claim.holds, [...ids.map(lineKey), ...ids.slice(0, 3).map(gapKey)].sort());
		assert.deepEqual(claim.deps, ["a0"]);
	});

	it("an independent edit inside the span conflicts", () => {
		const { repo, claim } = setup();
		const report = repo.check(
			repo.draft({ author: "other", message: "tweak b", edits: [{ file: "render.ts", old: "b = 2", new: "b = 20" }] }),
		);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.kind, "semantic");
		assert.deepEqual(report.conflicts[0]!.sides[0], {
			atom: claim.id,
			author: "refactor-agent",
			message: "about to restructure the body of render",
		});
	});

	it("an independent insertion into a held gap conflicts", () => {
		const { repo } = setup();
		const report = repo.check(
			repo.draft({
				edits: [{ file: "render.ts", old: "  const b = 2;\n", new: "  const b = 2;\n  const d = 4;\n", mode: "after" }],
			}),
		);
		assert.equal(report.conflicts.length, 1);
		assert.ok(report.conflicts[0]!.keys.some((k) => k.key.startsWith("G:") && k.relation === "hold"));
	});

	it("an edit that needs the claim does not conflict", () => {
		const { repo, claim } = setup();
		const report = repo.check(
			repo.draft({ edits: [{ file: "render.ts", old: "b = 2", new: "b = 20" }], needs: [claim.id] }),
		);
		assert.deepEqual(report.conflicts, []);
	});

	it("an edit outside the span does not conflict", () => {
		const { repo } = setup();
		const report = repo.check(
			repo.draft({ edits: [{ file: "render.ts", old: "export { render };", new: "export { render as draw };" }] }),
		);
		assert.deepEqual(report.conflicts, []);
	});
});

describe("7. reason warning", () => {
	const setup = () => {
		const repo = Repo.init({
			"filter.ts": lines("export function keep(x: number) {", "  return x > 0;", "}"),
			"sort.ts": lines("export function before(a: number, b: number) {", "  return a < b;", "}"),
		});
		const p = repo.edit({ message: "invert keep", edits: [{ file: "filter.ts", old: "x > 0", new: "x <= 0" }] });
		const q = repo.edit({
			message: "invert before",
			edits: [{ file: "sort.ts", old: "a < b", new: "a >= b" }],
			reasons: [{ to: p.id, kind: "together", text: "this logic was inverted, so that logic was too" }],
		});
		return { repo, p, q };
	};

	it("changing one side only warns, in either direction", () => {
		const { repo, p, q } = setup();
		const onlyP = repo.check(repo.draft({ edits: [{ file: "filter.ts", old: "x <= 0", new: "x < 0" }] }));
		assert.deepEqual(onlyP.warnings, [
			{
				atom: p.id,
				partner: q.id,
				text: "this logic was inverted, so that logic was too",
				message: `${p.id} was changed together with ${q.id} because: this logic was inverted, so that logic was too; you changed ${p.id}'s lines but not ${q.id}'s.`,
			},
		]);
		const onlyQ = repo.check(repo.draft({ edits: [{ file: "sort.ts", old: "a >= b", new: "a > b" }] }));
		assert.deepEqual(
			onlyQ.warnings.map((w) => [w.atom, w.partner]),
			[[q.id, p.id]],
		);
	});

	it("changing both sides, or reading the other side, does not warn", () => {
		const { repo } = setup();
		const both = repo.check(
			repo.draft({
				edits: [
					{ file: "filter.ts", old: "x <= 0", new: "x < 0" },
					{ file: "sort.ts", old: "a >= b", new: "a > b" },
				],
			}),
		);
		assert.deepEqual(both.warnings, []);
		const relying = repo.check(
			repo.draft({
				edits: [{ file: "filter.ts", old: "x <= 0", new: "x < 0" }],
				reliesOn: [{ file: "sort.ts", start: 1, end: 2 }],
			}),
		);
		assert.deepEqual(relying.warnings, []);
	});

	it("saying why the other side is fine (a reason to it) silences the warning", () => {
		const { repo, q } = setup();
		const report = repo.check(
			repo.draft({
				edits: [{ file: "filter.ts", old: "x <= 0", new: "x < 0" }],
				reasons: [{ to: q.id, kind: "because-of", text: "zero is excluded on purpose; before() is unaffected" }],
			}),
		);
		assert.deepEqual(report.warnings, []);
	});

	it("inserting a line between two lines of one side's change warns", () => {
		const repo = Repo.init({
			"filter.ts": lines("export function keep(x: number) {", "  return x > 0;", "}"),
			"sort.ts": lines("export function before(a: number, b: number) {", "  return a < b;", "}"),
		});
		const p = repo.edit({
			message: "invert keep",
			edits: [{ file: "filter.ts", old: "  return x > 0;\n", new: "  if (x === 0) return true;\n  return x < 0;\n" }],
		});
		const q = repo.edit({
			message: "invert before",
			edits: [{ file: "sort.ts", old: "a < b", new: "a >= b" }],
			reasons: [{ to: p.id, kind: "together", text: "this logic was inverted, so that logic was too" }],
		});
		const inside = repo.draft({
			edits: [{ file: "filter.ts", start: 2, end: 2, lines: ["  if (Number.isNaN(x)) return false;"] }],
		});
		assert.deepEqual(
			repo.check(inside).warnings.map((w) => [w.atom, w.partner]),
			[[p.id, q.id]],
		);
		// Right after the last line of p's change is outside it: no warning.
		const after = repo.draft({ edits: [{ file: "filter.ts", start: 3, end: 3, lines: ["  // done"], mode: "after" }] });
		assert.deepEqual(repo.check(after).warnings, []);
	});

	it("when the other side only deleted lines, touching a line next to the deletion counts as touching it", () => {
		const repo = Repo.init({
			"check.ts": lines("export function allowed(x: number) {", "  return x > 0;", "}"),
			"call.ts": lines("if (!ready) return;", "run();", "done();"),
		});
		const p = repo.edit({ message: "invert the check", edits: [{ file: "check.ts", old: "x > 0", new: "x <= 0" }] });
		const q = repo.edit({
			message: "drop the ready guard",
			edits: [{ file: "call.ts", old: "if (!ready) return;\n", new: "" }],
			reasons: [{ to: p.id, kind: "together", text: "the inverted check replaces the guard" }],
		});
		const onlyP = repo.check(repo.draft({ edits: [{ file: "check.ts", old: "x <= 0", new: "x < 0" }] }));
		assert.deepEqual(
			onlyP.warnings.map((w) => [w.atom, w.partner]),
			[[p.id, q.id]],
		);
		// Putting the guard back, right where it was, touches q's side.
		const restore = repo.check(
			repo.draft({
				edits: [
					{ file: "check.ts", old: "x <= 0", new: "x > 0" },
					{ file: "call.ts", start: 0, end: 0, lines: ["if (!ready) return;"] },
				],
			}),
		);
		assert.deepEqual(restore.warnings, []);
		// An edit elsewhere in that file doesn't.
		const elsewhere = repo.check(
			repo.draft({
				edits: [
					{ file: "check.ts", old: "x <= 0", new: "x > 0" },
					{ file: "call.ts", old: "done();", new: "finish();" },
				],
			}),
		);
		assert.deepEqual(
			elsewhere.warnings.map((w) => w.partner),
			[q.id],
		);
	});
});

describe("8. drop", () => {
	it("removes the atom and its dependents, and the projection reflows", () => {
		const repo = Repo.init({
			"list.ts": lines("const items = [", '  "a",', '  "b",', "];"),
			"other.ts": lines("let n = 1;"),
		});
		const base = repo.files();
		const addC = repo.edit({
			message: "add c",
			edits: [{ file: "list.ts", old: '  "b",\n', new: '  "b",\n  "c",\n' }],
		});
		const addD = repo.edit({
			message: "add d after c",
			edits: [{ file: "list.ts", old: '  "c",\n', new: '  "c",\n  "d",\n' }],
		});
		const fixC = repo.edit({ message: "C is upper case", edits: [{ file: "list.ts", old: '"c"', new: '"C"' }] });
		const removeA = repo.edit({ message: "drop a", edits: [{ file: "list.ts", old: '  "a",\n', new: "" }] });
		const other = repo.edit({ message: "n is 2", edits: [{ file: "other.ts", old: "1", new: "2" }] });
		assert.equal(repo.text("list.ts"), lines("const items = [", '  "b",', '  "C",', '  "d",', "];"));

		const dropped = drop(repo.graph, repo.shared, addC.id);
		assert.deepEqual(dropped.removed, [addC.id, addD.id, fixC.id]);
		assert.deepEqual([...dropped.set].sort(), ["a0", removeA.id, other.id].sort());
		const files = project(repo.graph, dropped.set);
		assert.equal(files["list.ts"], lines("const items = [", '  "b",', "];"));
		assert.equal(files["other.ts"], lines("let n = 2;"));

		// Dropping a deletion brings the line back.
		const undone = drop(repo.graph, dropped.set, removeA.id);
		assert.deepEqual(undone.removed, [removeA.id]);
		assert.deepEqual(project(repo.graph, undone.set), { ...base, "other.ts": lines("let n = 2;") });
	});
});

describe("9. labels", () => {
	const repo = Repo.init({ "app.ts": lines("export const a = 1;", "export const b = 2;", "export const c = 3;") });
	const x1 = repo.edit({ message: "a is 10", edits: [{ file: "app.ts", old: "a = 1", new: "a = 10" }] });
	const x2 = repo.edit({
		message: "b is a doubled",
		edits: [{ file: "app.ts", old: "b = 2", new: "b = a * 2" }],
		needs: [x1.id],
	});
	const x3 = repo.edit({ message: "c is 30", edits: [{ file: "app.ts", old: "c = 3", new: "c = 30" }] });
	const head = repo.edit({ message: "constants feature", needs: [x2.id, x3.id] });
	const y1 = repo.edit({ message: "a is 100", edits: [{ file: "app.ts", old: "a = 10", new: "a = 100" }] });
	const graph: Graph = repo.graph;
	graph.setLabel({ name: "constants", head: head.id, title: "Constants", message: "set the constants" });
	graph.setLabel({
		name: "bigger-a",
		head: y1.id,
		base: "constants",
		title: "Bigger a",
		message: "a grows",
		follows: ["constants"],
	});

	it("contents are closure(head) minus closure(base), in history order", () => {
		assert.deepEqual(labelContents(graph, graph.label("constants")!), [x1.id, x3.id, x2.id, head.id]);
		assert.deepEqual(labelContents(graph, graph.label("bigger-a")!), [y1.id]);
		assert.deepEqual(labelContents(graph, { head: x2.id, base: x1.id }), [x2.id]);
	});

	it("any atom inside a label re-slices into a smaller label", () => {
		assert.deepEqual(reslice(graph, graph.label("constants")!, x2.id), [x1.id, x2.id]);
		assert.deepEqual(reslice(graph, graph.label("constants")!, x3.id), [x3.id]);
		assert.throws(() => reslice(graph, graph.label("constants")!, y1.id), { code: "not-in-set" });
		const files = project(graph, graph.closure(x2.id));
		assert.equal(files["app.ts"], lines("export const a = 10;", "export const b = a * 2;", "export const c = 3;"));
	});

	it("history orders by lamport, then seq, and shows deps", () => {
		const order = history(graph, repo.shared);
		assert.deepEqual(
			order.map((a) => a.id),
			["a0", x1.id, x3.id, x2.id, y1.id, head.id],
		);
		const lamports = order.map((a) => graph.lamport(a.id));
		assert.deepEqual(lamports, [0, 1, 1, 2, 2, 3]);
		// y1 rewrites x1's line and depends on nothing else, not on x2 below it.
		assert.deepEqual(graph.atom(y1.id).deps, [x1.id]);
		// x2 and y1 have no path between them: same lamport, no real order.
		assert.ok(!graph.closure(x2.id).has(y1.id) && !graph.closure(y1.id).has(x2.id));
		assert.ok(!graph.closure(head.id).has(y1.id) && !graph.closure(y1.id).has(head.id));
	});

	it("labels survive a JSON round trip", () => {
		const again = Graph.fromJSON(JSON.parse(JSON.stringify(graph)));
		assert.deepEqual(again.labels(), graph.labels());
		assert.deepEqual(labelContents(again, again.label("bigger-a")!), [y1.id]);
	});
});
