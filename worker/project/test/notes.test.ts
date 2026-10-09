// Notes on lines (#44, step 2): a note is anchored to line ids, so it stays
// on the code it's about while others change the file around it. The lines'
// authors, the change's agent and the thread hear it as news. An objection
// whose lines are all changed or taken out is "addressed", and its writer
// hears so; only the writer closes a note.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

const AUTH = "export function login(user) {\n  return check(user);\n}\n";

function setup() {
	const store = new MemoryStore();
	const project = new Project(store, { now: () => 100 });
	project.init({ "auth.ts": "// auth\n", "notes.md": "# notes\n" }, 0);
	for (const a of ["builder", "security", "writer"]) project.sync(a);
	project.starting("builder", "Sign-in", ["auth.ts"], 1);
	edit(project, "builder", { file: "auth.ts", content: `// auth\n${AUTH}` }, 2);
	project.publish("builder", "Add login", 3);
	for (const a of ["security", "writer"]) project.sync(a);
	return { project, store };
}

test("a note follows its lines as the file changes around them, and reaches the author as news", () => {
	const { project, store } = setup();
	const noteAt = store.entries.findIndex((e) => e.type === "starting");
	const n = project.note(
		"security",
		{ file: "auth.ts", from: 3, to: 3, text: "check doesn't verify the state", kind: "objection" },
		4,
	);
	assert.deepEqual(n, { id: 1, change: noteAt, lines: [3, 3] });
	const news = project.news("builder").news;
	assert.ok(
		news.some((x) =>
			x.startsWith('security objects on auth.ts line 3 (change "Sign-in"): "check doesn\'t verify the state". Fix it'),
		),
		JSON.stringify(news),
	);
	// writer adds lines above: the note moves down with its line.
	edit(project, "writer", { file: "auth.ts", old: "// auth\n", new: "// auth\n// sign-in, see notes.md\n\n" }, 5);
	project.publish("writer", "Header", 6);
	assert.deepEqual(
		project.notes({ file: "auth.ts" }).notes.map((x) => [x.id, x.lines, x.state]),
		[[1, [5, 5], "open"]],
	);
	// On the change page.
	assert.deepEqual(
		project.change(noteAt).notes.map((x) => [x.agent, x.kind, x.text]),
		[["security", "objection", "check doesn't verify the state"]],
	);
});

test("replies make a thread whose writers hear each other; read marks are quiet", () => {
	const { project } = setup();
	project.note("security", { file: "auth.ts", from: 2, to: 4, text: "Why no rate limit?" }, 4);
	project.news("builder");
	const r = project.note("builder", { reply: 1, text: "The Worker limits it before this." }, 5);
	assert.deepEqual(r.lines, [2, 4]);
	assert.ok(project.news("security").news.some((x) => x.startsWith("builder replies on auth.ts lines 2-4")));
	project.note("writer", { file: "auth.ts", from: 2, to: 2, text: "read", kind: "read" }, 6);
	assert.equal(project.news("builder").news.length, 0, "a read mark sends no news");
	assert.deepEqual(
		project.notes().notes.map((x) => [x.id, x.reply, x.kind]),
		[
			[1, null, "comment"],
			[2, 1, "comment"],
			[3, null, "read"],
		],
	);
});

test("fixing every line an objection is on marks it addressed and tells its writer; only the writer closes it", () => {
	const { project } = setup();
	project.note("security", { file: "auth.ts", from: 3, to: 3, text: "verify the state", kind: "objection" }, 4);
	edit(
		project,
		"builder",
		{ file: "auth.ts", old: "  return check(user);\n", new: "  return check(user, state);\n" },
		5,
	);
	project.publish("builder", "Check the state", 6);
	assert.equal(project.notes().notes[0]!.state, "addressed");
	assert.ok(
		project
			.news("security")
			.news.some((x) => x.startsWith("builder's version 2 changed every line your objection 1 on auth.ts was on")),
	);
	assert.throws(() => project.closeNote("builder", 1, "resolved", 7), /only security, who wrote note 1, can close it/);
	assert.equal(project.closeNote("security", 1, "resolved", 7).state, "resolved");
	assert.ok(project.news("builder").news.some((x) => x.includes("security resolved its objection on auth.ts")));
});

test("a note on someone's unpublished draft sits on their lines and belongs to their change", () => {
	const { project, store } = setup();
	project.starting("builder", "Logout", undefined, 4);
	const logout = store.entries.length - 1;
	edit(project, "builder", { file: "auth.ts", old: "}\n", new: "}\nexport function logout() {}\n" }, 5);
	const n = project.note(
		"security",
		{ file: "auth.ts", from: 5, to: 5, text: "clear the session too", of: "builder" },
		6,
	);
	assert.deepEqual([n.change, n.lines], [logout, [5, 5]]);
	assert.throws(
		() => project.note("security", { file: "auth.ts", from: 1, to: 1, text: "x", of: "nobody" }, 7),
		/there is no agent "nobody"/,
	);
});

test("notes check their input, and come back the same from the log", () => {
	const { project, store } = setup();
	assert.throws(
		() => project.note("security", { file: "auth.ts", from: 9, to: 9, text: "x" }, 4),
		/from and to are line numbers in auth.ts, 1 to 4/,
	);
	assert.throws(() => project.note("security", { file: "auth.ts", from: 1, text: "" }, 4), /a note needs \{text\}/);
	assert.throws(
		() => project.note("security", { file: "auth.ts", from: 1, text: "x", kind: "approve" }, 4),
		/kind is comment, objection or read/,
	);
	assert.throws(() => project.note("security", { reply: 7, text: "x" }, 4), /there is no note 7/);
	project.note("security", { file: "auth.ts", from: 2, to: 3, text: "hm" }, 4);
	project.closeNote("security", 1, "withdrawn", 5);
	const again = Project.load(store.entries, new MemoryStore(), { now: () => 100 });
	assert.deepEqual(again.notes(), project.notes());
});
