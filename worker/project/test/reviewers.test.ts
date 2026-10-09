// Reviewers per area (#44, step 3): avcs.json's "review" names a reviewer
// for some paths. A version of shared that touches them tells the reviewer,
// once per change; the change page lists its reviewers and whether each has
// left a note. Nothing waits for a reviewer.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditBody, MemoryStore, Project } from "../project.ts";

function edit(project: Project, agent: string, body: EditBody, time: number): void {
	const a = project.edit(agent, body, time);
	if (!a.ok) throw new Error(`edit by ${agent} was out of step`);
}

const RULES = {
	review: [
		{ paths: ["src/auth/**"], reviewer: "security" },
		{ paths: ["docs/**", "README.md"], reviewer: "writer" },
	],
};

function setup() {
	const project = new Project(new MemoryStore(), { now: () => 100 });
	project.init(
		{
			"avcs.json": JSON.stringify(RULES) + "\n",
			"src/auth/login.ts": "export const login = 1;\n",
			"src/game.ts": "export const game = 1;\n",
			"README.md": "# readme\n",
		},
		0,
	);
	for (const a of ["builder", "security", "writer"]) project.sync(a);
	return project;
}

test("a version touching a reviewer's area tells the reviewer once per change, and lands at once", () => {
	const project = setup();
	project.starting("builder", "Sign-in", undefined, 1);
	edit(project, "builder", { file: "src/auth/login.ts", old: "1", new: "2" }, 2);
	const p = project.publish("builder", "login 2", 3);
	assert.ok(p.ok && "version" in p && p.version === 1, "nothing waits");
	const news = project.news("security").news;
	assert.equal(news.length, 1);
	assert.match(
		news[0]!,
		/^builder's change "Sign-in" touches src\/auth\/login\.ts \(version 1\), in your review area\. Read it: abso review \d+\.$/,
	);
	assert.equal(project.news("writer").news.length, 0, "not in the writer area");
	// A second version of the same change: no second line.
	edit(project, "builder", { file: "src/auth/login.ts", old: "2", new: "3" }, 4);
	project.publish("builder", "login 3", 5);
	assert.equal(project.news("security").news.length, 0);
});

test("the change page lists its reviewers, and read once the reviewer leaves a note", () => {
	const project = setup();
	edit(project, "builder", { file: "src/auth/login.ts", old: "1", new: "2" }, 1);
	edit(project, "builder", { file: "README.md", old: "# readme", new: "# Readme" }, 1);
	project.publish("builder", "login and readme", 2);
	const id = project.changes(0).changes[0]!.id;
	assert.deepEqual(project.change(id).reviewers, [
		{ agent: "security", files: ["src/auth/login.ts"], read: false },
		{ agent: "writer", files: ["README.md"], read: false },
	]);
	project.note("security", { file: "src/auth/login.ts", from: 1, text: "read", kind: "read" }, 3);
	assert.deepEqual(
		project.change(id).reviewers.map((r) => [r.agent, r.read]),
		[
			["security", true],
			["writer", false],
		],
	);
});

test("a reviewer's own change doesn't notify it, and a project without rules or with bad ones notifies nobody", () => {
	const project = setup();
	edit(project, "security", { file: "src/auth/login.ts", old: "1", new: "2" }, 1);
	project.publish("security", "my own", 2);
	assert.equal(project.news("security").news.length, 0);
	// Bad rules from before init checked avcs.json: loaded from a log that holds them.
	const old = new MemoryStore();
	new Project(old).init({ "avcs.json": '{"placeholder": 1}\n', "src/a.ts": "a\n" }, 0);
	const bad = '{"review": [{"paths": "src/**", "reviewer": 3}]}';
	const plain = Project.load(
		JSON.parse(JSON.stringify(old.entries).replace(JSON.stringify('{"placeholder": 1}'), JSON.stringify(bad))),
		new MemoryStore(),
	);
	plain.sync("b");
	plain.sync("c");
	edit(plain, "b", { file: "src/a.ts", old: "a", new: "b" }, 1);
	plain.publish("b", "x", 2);
	assert.equal(plain.news("c").news.length, 0);
});
