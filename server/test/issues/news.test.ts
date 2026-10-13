// A reader's news (a person's or an agent's): answers to their asks, replies on asks
// they're in, @name mentions, and comments, edits and closes on issues they
// watch, by others, newest first, each read or not.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { IssuesStore, NEWS_MAX, type Sql } from "../../src/issues/store.ts";

function sql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec: (q, ...b) => {
			if (/^\s*(CREATE|ALTER)\b/i.test(q)) {
				db.exec(q);
				return { toArray: () => [] };
			}
			const rows = db.prepare(q).all(...(b as (string | number | null)[]));
			return { toArray: () => rows };
		},
	};
}

function store(): { s: IssuesStore; db: Sql; tick: () => number } {
	const db = sql();
	IssuesStore.createTables(db);
	let at = Date.parse("2026-10-10T03:00:00Z");
	return { s: new IssuesStore(db, () => at), db, tick: () => (at += 1000) };
}

const ann = { person: "acct_ann" };
const fay = { agent: "fay" };

describe("a reader's news", () => {
	it("gathers answers, replies, mentions and watched changes by others, newest first", () => {
		const { s, tick } = store();
		const id = s.open(ann, { title: "Sync is slow" }).id;
		const other = s.open(fay, { title: "Not watched" }).id;
		tick();
		const ask = s.ask(ann, { issue: id, of: "fay", question: "Which way?" });
		tick();
		s.reply(fay, ask.id, { text: "staging or live?", question: true });
		tick();
		s.answer(fay, ask.id, { words: "live" });
		tick();
		s.comment(fay, id, { text: "a comment on a watched issue" });
		tick();
		s.comment(fay, other, { text: "cc @ann, have a look" });
		tick();
		s.comment(fay, other, { text: "no name here, and an email ann@x.dev isn't one" });
		tick();
		s.edit(fay, id, { title: "Sync is slow on big projects" });
		tick();
		s.markDone(fay, id, 12);
		tick();
		s.comment(ann, id, { text: "my own comment isn't news" });

		const news = s.newsFor({ person: "acct_ann" }, ["ann"]);
		assert.deepEqual(
			news.map((n) => [n.kind, n.issue]),
			[
				["closed", id],
				["edit", id],
				["mention", other],
				["comment", id],
				["answer", id],
				["reply", id],
			],
		);
		assert.equal(news.find((n) => n.kind === "answer")!.text, "live");
		assert.equal(news.find((n) => n.kind === "answer")!.ask, ask.id);
		assert.equal(news.find((n) => n.kind === "edit")!.text, "title");
		assert.ok(news.every((n) => !n.read && n.by === "fay"));
		assert.deepEqual(
			s
				.newsFor({ person: "acct_ann" }, [])
				.map((n) => n.kind)
				.includes("mention"),
			false,
			"no names, no mentions",
		);
	});

	it("marks read up to a time, never back, per person", () => {
		const { s, tick } = store();
		const id = s.open(ann, { title: "One" }).id;
		tick();
		s.comment(fay, id, { text: "first" });
		const mark = tick();
		tick();
		s.comment(fay, id, { text: "second" });
		assert.equal(s.markNewsRead({ person: "acct_ann" }, mark).read, mark);
		assert.equal(s.markNewsRead({ person: "acct_ann" }, 0).read, mark, "a mark never goes back");
		assert.deepEqual(
			s.newsFor({ person: "acct_ann" }, []).map((n) => [n.text, n.read]),
			[
				["second", false],
				["first", true],
			],
		);
		assert.ok(s.newsFor({ person: "acct_bo" }, []).every((n) => !n.read));
	});

	it("pages back with before, keeps at most NEWS_MAX and cuts long text", () => {
		const { s, tick } = store();
		const id = s.open(ann, { title: "Busy" }).id;
		for (let i = 0; i < NEWS_MAX + 5; i++) {
			tick();
			s.comment(fay, id, { text: i === 0 ? "x".repeat(400) : `comment ${i}` });
		}
		const first = s.newsFor({ person: "acct_ann" }, []);
		assert.equal(first.length, NEWS_MAX);
		const older = s.newsFor({ person: "acct_ann" }, [], first.at(-1)!.at);
		assert.equal(older.length, 5);
		assert.equal(older.at(-1)!.text.length, 280);
	});

	it("doesn't move the change count", () => {
		const { s } = store();
		s.open(ann, { title: "One" });
		const before = s.changes();
		s.markNewsRead({ person: "acct_ann" }, 5);
		assert.equal(s.changes(), before);
	});

	it("is an agent's too: answers to its asks and @mentions of its name", () => {
		const { s, tick } = store();
		const lead = { agent: "lead" };
		const id = s.open(fay, { title: "Sync is slow" }).id;
		tick();
		const ask = s.ask(lead, { issue: id, of: "fay", question: "Which way?" });
		tick();
		s.answer(fay, ask.id, { words: "live" });
		tick();
		s.comment(fay, id, { text: "@lead it's done" });
		assert.deepEqual(
			s.newsFor(lead, ["lead"]).map((n) => [n.kind, n.by, n.text]),
			[
				["mention", "fay", "@lead it's done"],
				["answer", "fay", "live"],
			],
		);
	});
});
