// Reads for the Files pages (#41, docs/website/stories/files.md): a folder
// with each entry's last change, a path's life, any spelling, lines followed
// forward, files as an agent has them, whether drafts would collide, and a
// file's history across moves.

import assert from "node:assert/strict";
import { test } from "node:test";
import { blame, folderBlame, why } from "../blame.ts";
import { MemoryStore, Project } from "../project.ts";

function setup() {
	const project = new Project(new MemoryStore());
	project.init(
		{
			"README.md": "# game\n",
			"src/coast/tide.ts": "export const tide = 1;\nexport const wave = 2;\nexport const foam = 3;\n",
			"src/sky.ts": "export const sky = 1;\n",
		},
		0,
	);
	for (const a of ["ann", "bob", "cat"]) project.sync(a);
	return project;
}

test("a folder lists its folders and files, each with its last change", () => {
	const p = setup();
	p.edit("ann", { file: "src/sky.ts", old: "1", new: "2" }, 10);
	p.publish("ann", "sky is 2", 11); // v1
	p.edit("bob", { file: "src/coast/tide.ts", old: "tide = 1", new: "tide = 9" }, 20);
	p.publish("bob", "high tide", 21); // v2
	const root = p.tree();
	assert.deepEqual(
		root.entries.map((e) => [e.kind, e.name, e.files, e.last?.version, e.last?.agent]),
		[
			["folder", "src", 2, 2, "bob"],
			["file", "README.md", undefined, 0, "init"],
		],
	);
	const src = p.tree("SRC"); // any spelling
	assert.equal(src.folder, "src");
	assert.deepEqual(
		src.entries.map((e) => [e.name, e.last?.version, e.last?.message]),
		[
			["coast", 2, "high tide"],
			["sky.ts", 1, "sky is 2"],
		],
	);
	// At an earlier version, the last change is the one then.
	assert.deepEqual(
		p.tree("src", { version: 1 }).entries.map((e) => e.last?.version),
		[0, 1],
	);
	assert.throws(() => p.tree("nope"), /there is no folder nope/);
	// Kept up as versions land.
	p.sync("ann");
	p.edit("ann", { file: "README.md", old: "game", new: "Game" }, 30);
	p.publish("ann", "capital", 31); // v3
	assert.equal(p.tree().entries[1]!.last?.version, 3);
});

test("a path's life: versions that changed it, the version that made it, and the one that took it out", () => {
	const p = setup();
	p.record("ann", { "src/new.ts": "x\n" }, 10);
	p.publish("ann", "new file", 11); // v1
	p.sync("bob");
	p.record("bob", { "src/new.ts": null }, 20);
	p.publish("bob", "not needed", 21); // v2
	assert.deepEqual(p.pathLife("src/new.ts", { version: 1 }), {
		path: "src/new.ts",
		version: 1,
		exists: true,
		versions: 1,
		last: { version: 1, agent: "ann", time: 11, message: "new file" },
		made: { version: 1, agent: "ann", time: 11, message: "new file" },
	});
	const gone = p.pathLife("SRC/NEW.TS");
	assert.deepEqual(
		[gone.path, gone.exists, gone.versions, gone.removed?.version, gone.removed?.agent],
		["src/new.ts", false, 2, 2, "bob"],
	);
	// Before it existed: the version that makes it next.
	const before = p.pathLife("src/new.ts", { version: 0 });
	assert.deepEqual([before.exists, before.next?.version, before.removed], [false, 1, undefined]);
});

test("a move shows in both lives: where the file went, and where it came from", () => {
	const p = setup();
	p.move("ann", "src/sky.ts", "src/air/sky.ts", 10);
	p.publish("ann", "sky into air", 11); // v1
	assert.equal(p.pathLife("src/sky.ts").removed?.to, "src/air/sky.ts");
	assert.equal(p.pathLife("src/air/sky.ts").made?.from, "src/sky.ts");
});

test("reads take any spelling and answer with the stored one", () => {
	const p = setup();
	assert.deepEqual(
		[p.fileAt("Src/Coast/Tide.TS", 0).path, p.fileAt("Src/Coast/Tide.TS", 0).text?.split("\n")[0]],
		["src/coast/tide.ts", "export const tide = 1;"],
	);
	assert.equal(blame(p, "SRC/SKY.TS").file, "src/sky.ts");
	assert.equal(why(p, "src/Sky.ts", 1).file, "src/sky.ts");
	p.edit("ann", { file: "src/sky.ts", old: "1", new: "2" }, 10);
	p.publish("ann", "sky is 2", 11);
	const log = p.log({ path: "SRC/sky.ts" });
	assert.deepEqual([log.path, log.versions.map((v) => v.version)], ["src/sky.ts", [1, 0]]);
	p.note("bob", { file: "src/sky.ts", from: 1, text: "why 2?" }, 12);
	assert.equal(p.notes({ file: "Src/Sky.ts" }).notes.length, 1);
	// A project holding two spellings (one from before #49's checks, loaded from its log) answers each exactly.
	const old = new MemoryStore();
	new Project(old).init({ "a.md": "lower\n", "X.md": "upper\n" }, 0);
	const q = Project.load(JSON.parse(JSON.stringify(old.entries).replaceAll("X.md", "A.md")), new MemoryStore());
	assert.equal(q.fileAt("A.md", 0).text, "upper\n");
	assert.equal(q.fileAt("a.md", 0).text, "lower\n");
	assert.equal(q.fileAt("a.MD", 0).text, null, "two matches: answered exactly, and a.MD itself is not there");
});

test("lines followed forward: new numbers after edits above them, into a moved file, and the version that took lines out", () => {
	const p = setup();
	p.edit(
		"ann",
		{ file: "src/coast/tide.ts", old: "export const tide = 1;\n", new: "// tides\nexport const tide = 1;\n" },
		10,
	);
	p.publish("ann", "comment", 11); // v1
	p.sync("bob");
	p.edit("bob", { file: "src/coast/tide.ts", old: "export const foam = 3;\n", new: "" }, 20);
	p.publish("bob", "no foam", 21); // v2
	const f = p.follow("src/coast/tide.ts", 0, 1, 3);
	assert.deepEqual(f.lines, [
		{ was: 1, file: "src/coast/tide.ts", now: 2 },
		{ was: 2, file: "src/coast/tide.ts", now: 3 },
		{ was: 3, now: null, removed: 2 },
	]);
	assert.deepEqual(
		[f.ranges, f.removed, f.at],
		[[{ file: "src/coast/tide.ts", from: 2, to: 3 }], [{ from: 3, to: 3, version: 2 }], 2],
	);
	// Up to a chosen version only.
	assert.deepEqual(p.follow("src/coast/tide.ts", 0, 3, 3, { at: 1 }).lines, [
		{ was: 3, file: "src/coast/tide.ts", now: 4 },
	]);
	// Into a moved file.
	p.sync("cat");
	p.move("cat", "src/coast/tide.ts", "src/sea/tide.ts", 30);
	p.publish("cat", "coast is sea", 31); // v3
	assert.deepEqual(p.follow("src/coast/tide.ts", 0, 1, 2).ranges, [{ file: "src/sea/tide.ts", from: 2, to: 3 }]);
	assert.throws(() => p.follow("src/coast/tide.ts", 0, 0, 2), /ask for from\.\.to within 1-3/);
	assert.throws(() => p.follow("src/coast/tide.ts", 2, 1, 1, { at: 1 }), /follow goes forward/);
	assert.throws(() => p.follow("nope.ts", 0, 1, 1), /nope\.ts isn't in shared at version 0/);
});

test("a dropped version takes its lines out too, and follow says which drop", () => {
	const p = setup();
	p.edit(
		"ann",
		{ file: "src/sky.ts", old: "export const sky = 1;\n", new: "export const sky = 1;\nexport const cloud = 2;\n" },
		10,
	);
	p.publish("ann", "cloud", 11); // v1
	p.drop("bob", [1], "no clouds", 20); // v2
	assert.deepEqual(p.follow("src/sky.ts", 1, 2, 2).removed, [{ from: 2, to: 2, version: 2 }]);
});

test("files as an agent has them: its own new files in, and an unknown agent isn't made", () => {
	const p = setup();
	p.record("ann", { "notes/plan.md": "plan\n" }, 10);
	assert.deepEqual(p.pathsOf("ann"), {
		agent: "ann",
		version: 0,
		draft: null,
		files: ["README.md", "notes/plan.md", "src/coast/tide.ts", "src/sky.ts"],
	});
	assert.throws(() => p.pathsOf("nobody"), /there is no agent "nobody"/);
	assert.ok(!p.status().agents.some((a) => a.agent === "nobody"));
});

test("drafts that would collide by the publish rule: lines, a definition, and a name defined twice", () => {
	const p = setup();
	p.edit("ann", { file: "src/coast/tide.ts", old: "wave = 2", new: "wave = 20" }, 10);
	p.edit("bob", { file: "src/coast/tide.ts", old: "wave = 2", new: "wave = 22" }, 11);
	let c = p.collisions();
	assert.deepEqual(c.agents, ["ann", "bob"]);
	assert.deepEqual(
		c.collisions.map((x) => [x.kind, x.file, x.first.agent, x.first.lines, x.second.agent, x.second.lines]),
		[["lines", "src/coast/tide.ts", "ann", [2, 2], "bob", [2, 2]]],
	);
	assert.equal(c.version, 0);
	// Narrowed to a file or folder; elsewhere, none.
	assert.equal(p.collisions({ file: "SRC/coast/tide.ts" }).collisions.length, 1);
	assert.equal(p.collisions({ folder: "src/coast" }).collisions.length, 1);
	assert.equal(p.collisions({ file: "src/sky.ts" }).collisions.length, 0);
	// The publish rule agrees: once ann publishes, bob is refused.
	p.publish("ann", "wave 20", 12);
	assert.equal(p.publish("bob", "wave 22", 13).ok, false);

	// A definition: cat changes sky; bob's new line uses it.
	const q = setup();
	q.edit("cat", { file: "src/sky.ts", old: "export const sky = 1;", new: 'export const sky = "blue";' }, 10);
	q.record("bob", { "src/use.ts": "import { sky } from './sky.ts';\nexport const twice = sky * 2;\n" }, 12);
	c = q.collisions();
	const def = c.collisions.filter((x) => x.kind === "definition");
	assert.deepEqual(
		def.map((x) => [x.name, x.first.agent, x.first.file, x.second.agent, x.second.file]),
		[["sky", "cat", "src/sky.ts", "bob", "src/use.ts"]],
	);

	// Two agents each define the same name at the top of one file.
	const r = setup();
	r.edit(
		"ann",
		{
			file: "src/sky.ts",
			old: "export const sky = 1;\n",
			new: "export const sky = 1;\nexport function rain() { return 1; }\n",
		},
		10,
	);
	r.edit(
		"bob",
		{
			file: "src/sky.ts",
			old: "export const sky = 1;\n",
			new: "export function rain() { return 2; }\nexport const sky = 1;\n",
		},
		11,
	);
	const dup = r.collisions().collisions.filter((x) => x.kind === "duplicate");
	assert.deepEqual(
		dup.map((x) => [x.name, x.first.agent, x.second.agent]),
		[["rain", "ann", "bob"]],
	);
});

test("with follow, a file's history goes back through abso mv: versions under its old name come with that name", () => {
	const p = setup();
	p.edit("ann", { file: "src/sky.ts", old: "1", new: "2" }, 10);
	p.publish("ann", "sky is 2", 11); // v1
	p.sync("bob");
	p.move("bob", "src/sky.ts", "src/air/sky.ts", 20);
	p.publish("bob", "sky into air", 21); // v2
	p.sync("ann");
	p.edit("ann", { file: "src/air/sky.ts", old: "2", new: "3" }, 30);
	p.publish("ann", "sky is 3", 31); // v3
	const log = p.log({ path: "src/air/sky.ts", follow: true });
	assert.deepEqual(
		log.versions.map((v) => [v.version, v.path]),
		[
			[3, undefined],
			[2, undefined],
			[1, "src/sky.ts"],
			[0, "src/sky.ts"],
		],
	);
	assert.deepEqual(log.movedFrom, [{ path: "src/sky.ts", version: 2 }]);
	// Paging still works across the move.
	assert.deepEqual(
		p.log({ path: "src/air/sky.ts", follow: true, limit: 2, before: 2 }).versions.map((v) => v.version),
		[1, 0],
	);
	// Without follow, as before: the versions that changed this name only.
	assert.deepEqual(
		p.log({ path: "src/air/sky.ts" }).versions.map((v) => [v.version, v.path]),
		[
			[3, undefined],
			[2, undefined],
		],
	);
	// The old name's own history is unchanged.
	assert.deepEqual(
		p.log({ path: "src/sky.ts" }).versions.map((v) => v.version),
		[2, 1, 0],
	);
});

test("who wrote a folder: its lines counted by author, most first", () => {
	const p = setup();
	p.edit(
		"ann",
		{
			file: "src/coast/tide.ts",
			old: "export const foam = 3;\n",
			new: "export const foam = 3;\nexport const a = 1;\nexport const b = 2;\n",
		},
		10,
	);
	p.publish("ann", "two more", 11);
	assert.deepEqual(folderBlame(p, "src"), {
		folder: "src",
		version: 1,
		files: 2,
		lines: 6,
		authors: [
			{ agent: "init", lines: 4 },
			{ agent: "ann", lines: 2 },
		],
	});
	assert.equal(folderBlame(p, "").lines, 7);
	assert.equal(folderBlame(p, "Src/Coast").folder, "src/coast");
	assert.throws(() => folderBlame(p, "nope"), /there is no folder nope/);
});

test("why says what the line's change built on: the versions that brought in what it depends on directly, nearest first", () => {
	const p = setup();
	p.edit(
		"ann",
		{ file: "src/sky.ts", old: "export const sky = 1;\n", new: "export const sky = 1;\nexport const cloud = 2;\n" },
		10,
	);
	p.publish("ann", "cloud", 11); // v1
	p.sync("bob");
	p.edit(
		"bob",
		{ file: "src/sky.ts", old: "export const cloud = 2;\n", new: "export const cloud = 2;\nexport const rain = 3;\n" },
		20,
	);
	p.publish("bob", "rain", 21); // v2
	const w = why(p, "src/sky.ts", 3);
	assert.deepEqual(
		w.builtOn,
		[{ version: 1, agent: "ann", message: "cloud" }],
		"what it depends on directly: the line it was written after",
	);
	assert.deepEqual(why(p, "src/sky.ts", 1).builtOn, [], "the first version built on nothing");
});
