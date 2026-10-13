// Issues: the store and its routes, on node:sqlite as a Durable Object's SQLite.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { issuesRoute } from "../../src/issues/routes.ts";
import { IssuesStore, type Sql, WRITES_PER_MINUTE } from "../../src/issues/store.ts";

function sql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec: (q, ...b) => {
			// Like ctx.storage.sql.exec: the statement runs at once; rows come from toArray.
			if (/^\s*CREATE\b/i.test(q)) {
				db.exec(q);
				return { toArray: () => [] };
			}
			const rows = db.prepare(q).all(...(b as (string | number | null)[]));
			return { toArray: () => rows };
		},
	};
}

function store(): { s: IssuesStore; tick: (ms?: number) => void } {
	let t = Date.parse("2026-10-07T20:00:00Z");
	const db = sql();
	IssuesStore.createTables(db);
	return { s: new IssuesStore(db, () => t), tick: (ms = 1000) => void (t += ms) };
}

const builder = { agent: "builder3" };
const christopher = { person: "u1" };

describe("issues: statuses come from the work", () => {
	it("open, in progress, in review, blocked, done and dropped, and a dropped issue can be reopened", () => {
		const { s, tick } = store();
		const a = s.open(builder, { title: "Sign-in page", description: "Pages for sign-in" }).id;
		const b = s.open(builder, { title: "Logo", parent: a }).id;
		assert.equal(s.page(a).issue.status, "open");
		assert.equal(s.page(a).issue.children, 1);

		tick();
		s.claim("builder3", a, 4400);
		assert.equal(s.page(a).issue.status, "in progress");
		assert.deepEqual(s.page(a).issue.agents, ["builder3"]);

		tick();
		const review = s.ask(builder, { issue: a, of: "security", question: "Is the cookie set right?", review: true });
		assert.equal(s.page(a).issue.status, "in review");
		assert.deepEqual(s.page(a).issue.waitingOn, ["security"]);
		assert.deepEqual(review.news.to, ["security"]);
		assert.ok(review.news.text.endsWith(`: "Is the cookie set right?" Answer: abso answer ${review.id} "..."`));

		// A question that isn't a review blocks, and outranks the review; it can hold up other issues too.
		const q = s.ask(builder, {
			issue: a,
			of: "person:u1",
			question: "Take abso.dev?",
			options: ["Yes", "No"],
			blocks: [b],
			due: "2026-10-09",
		});
		assert.equal(s.page(a).issue.status, "blocked");
		assert.equal(s.page(b).issue.status, "blocked", "an ask holds up the issues it names in blocks");
		assert.deepEqual(s.page(a).issue.waitingOn, ["security", "person:u1"]);
		assert.ok(q.news.text.endsWith('"Take abso.dev?"'), "a person answers elsewhere, so no command");

		tick();
		const answered = s.answer(christopher, q.id, { option: "Yes", note: "Renew it for two years." });
		assert.equal(answered.ask.answer?.words, "Yes\n\nRenew it for two years.", "kept in the person's own words");
		assert.equal(s.page(b).issue.status, "open");
		assert.equal(s.page(a).issue.status, "in review");
		s.answer({ agent: "security" }, review.id, { words: "Looks right." });
		assert.equal(s.page(a).issue.status, "in progress");

		tick();
		const done = s.done("builder3", a, 13);
		assert.match(done.news!.text, /^builder3 finished issue 1 \("Sign-in page"\) in version 13$/);
		const page = s.page(a);
		assert.equal(page.issue.status, "done");
		assert.deepEqual(page.issue.closed, { how: "done", by: "builder3", version: 13, at: page.issue.closed!.at });
		assert.deepEqual(page.issue.versions, [13]);
		assert.deepEqual(page.claims, []);

		s.drop(builder, b);
		assert.equal(s.page(b).issue.status, "dropped");
		assert.throws(() => s.drop(builder, b), /dropped already/);
		assert.throws(() => s.markDone(builder, b, null), /reopen it/);
		const reopened = s.reopen(builder, b);
		assert.match(reopened.news.text, /reopened issue/);
		assert.equal(s.page(b).issue.status, "open");
		assert.throws(() => s.reopen(builder, b), /is open/);
		const marked = s.markDone(builder, b, 381);
		assert.match(marked.news.text, /done in version 381/);
		assert.equal(s.page(b).issue.status, "done");
		assert.deepEqual(s.page(b).issue.versions, [381]);
		assert.throws(() => s.reopen(builder, b), /stays done/);
		assert.throws(() => s.markDone(builder, b, null), /done already/);
		assert.deepEqual(
			s.list({ open: true }).map((i) => i.id),
			[],
		);
	});

	it("a start note that ends without --done takes the claim back and leaves the issue open", () => {
		const { s } = store();
		const id = s.open(builder, { title: "x" }).id;
		s.claim("builder3", id, 10);
		s.unclaim("builder3", id);
		assert.equal(s.page(id).issue.status, "open");
		// Hooks for an issue that doesn't exist are ignored: the start note stands either way.
		s.claim("builder3", 99, 10);
		s.unclaim("builder3", 99);
		assert.deepEqual(s.done("builder3", 99, 3), {});
	});

	it("lists by status and agent, most recently updated first", () => {
		const { s, tick } = store();
		const one = s.open(builder, { title: "one" }).id;
		tick();
		const two = s.open(builder, { title: "two" }).id;
		tick();
		s.comment({ agent: "engine" }, one, { text: "on it soon" });
		assert.deepEqual(
			s.list().map((i) => i.id),
			[one, two],
		);
		s.claim("engine", two, 5);
		assert.deepEqual(
			s.list({ agent: "engine" }).map((i) => i.id),
			[two],
		);
		assert.deepEqual(
			s.list({ status: "open" }).map((i) => i.id),
			[one],
		);
	});
});

describe("issues: the asker withdraws an ask", () => {
	it("closes like an answer: off the waiting list, no longer blocking, kept with the note, and the one asked hears it", () => {
		const { s } = store();
		const id = s.open(builder, { title: "How judges see abso" }).id;
		const ask = s.ask(builder, { of: "person:u1", question: "A, B or C?", issue: id, options: ["A", "B", "C"] });
		assert.equal(s.page(id).issue.status, "blocked");
		const r = s.withdraw(builder, ask.id, { note: "Overtaken by tonight's rulings" });
		assert.equal(r.ask.outcome, "withdrawn");
		assert.deepEqual(r.ask.answer && { by: r.ask.answer.by, words: r.ask.answer.words }, {
			by: "builder3",
			words: "Overtaken by tonight's rulings",
		});
		assert.deepEqual(r.news.to, ["person:u1"]);
		assert.match(r.news.text, /^builder3 withdrew their question of person:u1 on issue \d+: "Overtaken/);
		assert.deepEqual(s.waiting("person:u1"), []);
		assert.equal(s.page(id).issue.status, "open");
		assert.equal(s.page(id).asks[0]!.outcome, "withdrawn");
		assert.equal(s.answered("person:u1")[0]!.outcome, "withdrawn");
	});

	it("only the asker withdraws, only while unanswered, and once; then it can't be answered", () => {
		const { s } = store();
		const ask = s.ask(builder, { of: "person:u1", question: "Pick one" });
		assert.throws(() => s.withdraw(christopher, ask.id, {}), /asked by builder3; only they can withdraw it/);
		assert.throws(() => s.withdraw(builder, 99, {}), /there's no ask 99/);
		const r = s.withdraw(builder, ask.id, {});
		assert.equal(r.ask.answer!.words, "");
		assert.equal(r.news.text, "builder3 withdrew their question of person:u1", "no note, so nothing after it");
		assert.throws(() => s.withdraw(builder, ask.id, {}), /withdrawn already/);
		assert.throws(
			() => s.answer(christopher, ask.id, { words: "A" }),
			(e: { status?: number; message: string }) => e.status === 409 && /withdrawn by builder3/.test(e.message),
		);
		const answered = s.ask(builder, { of: "person:u1", question: "Another" });
		s.answer(christopher, answered.id, { words: "Yes" });
		assert.throws(() => s.withdraw(builder, answered.id, {}), /answered already, so there's nothing to withdraw/);
		assert.equal(s.answered("person:u1").find((a) => a.id === answered.id)!.outcome, undefined);
	});
});

describe("issues: the one asked acknowledges an ask", () => {
	it("stays open and blocking, shows the ack and its note, and the asker hears it; an answer closes it", () => {
		const { s } = store();
		const id = s.open(builder, { title: "Which deploy first" }).id;
		const ask = s.ask(builder, { of: "person:u1", question: "A or B?", issue: id });
		const r = s.ack(christopher, ask.id, { note: "after the review" });
		assert.equal(r.ask.ack!.note, "after the review");
		assert.equal(r.ask.answer, null);
		assert.deepEqual(r.news.to, ["builder3"]);
		assert.equal(
			r.news.text,
			`person:u1 has your question (ask ${ask.id}) on issue ${id} and will answer: "after the review"`,
		);
		assert.equal(s.page(id).issue.status, "blocked");
		assert.equal(s.page(id).asks[0]!.ack!.note, "after the review");
		assert.deepEqual(
			s.waiting("person:u1").map((a) => a.id),
			[ask.id],
		);
		// Again, with no note: the note and time update.
		const again = s.ack(christopher, ask.id, {});
		assert.equal(again.ask.ack!.note, "");
		assert.equal(again.news.text, `person:u1 has your question (ask ${ask.id}) on issue ${id} and will answer.`);
		s.answer(christopher, ask.id, { words: "A" });
		assert.equal(s.page(id).issue.status, "open");
		assert.deepEqual(s.waiting("person:u1"), []);
	});

	it("only the one asked acknowledges, and only while it's open", () => {
		const { s } = store();
		const ask = s.ask(builder, { of: "person:u1", question: "Pick one" });
		assert.throws(
			() => s.ack(builder, ask.id, {}),
			(e: { status?: number; message: string }) => e.status === 403 && /is for person:u1, not builder3/.test(e.message),
		);
		assert.throws(
			() => s.ack(christopher, 99, {}),
			(e: { status?: number }) => e.status === 404,
		);
		s.answer(christopher, ask.id, { words: "A" });
		assert.throws(
			() => s.ack(christopher, ask.id, {}),
			(e: { status?: number; message: string }) => e.status === 409 && /answered already/.test(e.message),
		);
		const gone = s.ask(builder, { of: "person:u1", question: "Another" });
		s.withdraw(builder, gone.id, {});
		assert.throws(
			() => s.ack(christopher, gone.id, {}),
			(e: { status?: number; message: string }) => e.status === 409 && /withdrawn by builder3/.test(e.message),
		);
	});
});

describe("issues: asks and answers", () => {
	it("an ask on no issue, a task answered done, and waiting sorted by due date", () => {
		const { s } = store();
		const id = s.open(builder, { title: "Sign-in" }).id;
		const later = s.ask(builder, {
			of: "person:u1",
			question: "Does the avcs command become abso?",
			due: "2026-10-20",
			recommendation: { text: "Yes, with avcs kept as an alias" },
		});
		const sooner = s.ask(builder, {
			of: "person:u1",
			kind: "task",
			question: "Upload the sign-in logo",
			due: "2026-10-08",
			blocks: [id],
		});
		const none = s.ask(builder, { of: "person:u1", question: "Anything else?" });
		const waiting = s.waiting("person:u1");
		assert.deepEqual(
			waiting.map((a) => a.id),
			[sooner.id, later.id, none.id],
		);
		assert.equal(waiting[1]!.issue, null);
		assert.equal(waiting[1]!.title, null);
		assert.deepEqual(waiting[1]!.recommendation, { text: "Yes, with avcs kept as an alias", by: "builder3" });
		assert.equal(s.page(id).issue.status, "blocked");
		s.answer(christopher, sooner.id, { done: true });
		assert.equal(s.answered("person:u1")[0]!.answer!.words, "done");
		assert.equal(s.page(id).issue.status, "open");
		assert.deepEqual(
			s.waiting("person:u1").map((a) => a.id),
			[later.id, none.id],
		);
	});

	it("only the one asked answers, once, from its options", () => {
		const { s } = store();
		const ask = s.ask(builder, { of: "person:u1", question: "Pick one", options: ["A", "B"] });
		assert.throws(() => s.answer({ person: "u2" }, ask.id, { words: "A" }), /is for person:u1, not person:u2/);
		assert.throws(() => s.answer(christopher, ask.id, { option: "C" }), /options are: "A", "B"/);
		// The page sends the option's text as it showed it: an index that names another is refused.
		assert.throws(
			() => s.answer(christopher, ask.id, { option: 1, expect: "A" }),
			(e: { status?: number; message: string }) =>
				e.status === 409 && /option 2 is "B", not the one you picked/.test(e.message),
		);
		s.answer(christopher, ask.id, { option: 1, expect: "B" });
		assert.throws(() => s.answer(christopher, ask.id, { words: "A" }), /answered already/);
		assert.equal(s.answered("person:u1")[0]!.answer!.words, "B");
	});

	it("checks its input", () => {
		const { s } = store();
		assert.throws(() => s.open(builder, { title: "" }), /the title is missing/);
		assert.throws(() => s.open(builder, { title: "x".repeat(201) }), /201 characters; the most is 200/);
		assert.throws(() => s.open(builder, { title: "x", parent: 7 }), /there's no issue 7/);
		assert.throws(
			() => s.open(builder, { title: "x", lines: { file: "a.ts", from: 3, to: 1, version: 2 } }),
			/lines are/,
		);
		assert.throws(() => s.ask(builder, { of: "x", question: "q", review: true }), /a review ask is on an issue/);
		assert.throws(() => s.ask(builder, { of: "x", question: "q", due: "soon" }), /due is a date/);
		assert.throws(() => s.ask(builder, { of: "x", question: "q", kind: "chore" }), /kind is "question", or "task"/);
	});
});

describe("issues: routes", () => {
	const call = (s: IssuesStore, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
		issuesRoute(
			s,
			new Request(`https://issues.internal${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}),
		).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

	it("agents write under /a/:agent/, a write naming nobody is refused, and everyone reads", async () => {
		const { s } = store();
		const opened = await call(s, "POST", "/p/web/a/builder3/issue", { title: "Sign-in", description: "d" });
		assert.equal(opened.status, 200);
		assert.equal(opened.json.id, 1);
		assert.equal((await call(s, "POST", "/p/web/a/fe/issue/1/comment", { text: "nice" })).status, 200);
		assert.equal((await call(s, "POST", "/p/web/issue/1/comment", { text: "who am I" })).status, 403);
		assert.equal(
			(await call(s, "POST", "/p/web/issue/1/comment", { text: "a person?" }, { "X-Avcs-User": "u1" })).status,
			403,
			"no header makes a person here",
		);
		const asked = await call(s, "POST", "/p/web/a/builder3/ask", { issue: 1, of: "fe", question: "OK?" });
		assert.equal(asked.json.news.to[0], "fe");
		assert.equal((await call(s, "POST", `/p/web/a/fe/answer/${asked.json.id}`, { words: "OK" })).status, 200);

		const list = await call(s, "GET", "/p/web/issues?open=1");
		assert.deepEqual(
			list.json.issues.map((i: { id: number; status: string }) => [i.id, i.status]),
			[[1, "open"]],
		);
		const page = await call(s, "GET", "/p/web/issue/1");
		assert.deepEqual(
			page.json.comments.map((c: { by: string }) => c.by),
			["fe"],
		);
		assert.equal(page.json.asks[0].answer.words, "OK");
		assert.equal((await call(s, "GET", "/p/web/issue/9")).status, 404);
		assert.equal((await call(s, "GET", "/p/web/answered")).status, 400);
		assert.equal((await call(s, "POST", "/p/web/a/builder3/issue", "not an object")).status, 400);
	});
});

describe("issues: edits, watchers, Blocked by and drafts", () => {
	it("an edit tells the watchers by default, adds people, or tells nobody", () => {
		const { s, tick } = store();
		const a = s.open(christopher, { title: "Accounts" }).id;
		const b = s.open(christopher, { title: "Sign-in", agent: "fe", notify: ["design"] });
		assert.deepEqual(b.news, {
			issue: null,
			text: 'person:u1 opened issue 2: "Sign-in" (Agent fe)',
			to: ["fe", "design"],
		});
		s.comment(builder, b.id, { text: "on it soon" });
		s.claim("engine", b.id, 40);
		tick();
		// Issue 1 opened before issue 2, then put under it.
		const moved = s.edit(christopher, b.id, { parent: a, title: "Sign-in flow" });
		assert.deepEqual(moved.notified, ["builder3", "design", "engine", "fe"]);
		assert.equal(moved.news!.text, 'person:u1 edited issue 2 ("Sign-in flow"): title was "Sign-in"; parent is issue 1');
		const page = s.page(b.id);
		assert.equal(page.issue.parent, a);
		assert.deepEqual(page.issue.watchers, ["builder3", "design", "engine", "fe", "person:u1"]);
		assert.deepEqual(page.edits[0]!.changes, {
			title: { from: "Sign-in", to: "Sign-in flow" },
			parent: { from: null, to: 1 },
		});
		const quiet = s.edit(builder, b.id, { description: "typo", notify: false });
		assert.deepEqual(quiet, { edit: 2, notified: [] });
		const more = s.edit(builder, b.id, { agent: "web", also: ["person:u2"] });
		assert.ok(
			more.notified.includes("person:u2") && more.notified.includes("web") && !more.notified.includes("builder3"),
		);
		assert.equal(s.page(b.id).issue.agent, "web");
		assert.throws(() => s.edit(builder, b.id, { agent: "web" }), /that changes nothing on issue 2/);
		assert.throws(() => s.edit(builder, a, { parent: b.id }), /issue 2 is issue 1 or under it/);
		assert.throws(() => s.edit(builder, a, { notify: "no", title: "A" }), /notify is true/);
	});

	it("Blocked by holds an issue Blocked until each is Done, and refuses a loop", () => {
		const { s } = store();
		const a = s.open(builder, { title: "Schema" }).id;
		const b = s.open(builder, { title: "Pages", blockedBy: [a] }).id;
		assert.equal(s.page(b).issue.status, "blocked");
		assert.deepEqual(s.page(b).issue.blockedBy, [a]);
		assert.throws(() => s.edit(builder, a, { blockedBy: [b] }), /issue 2 already waits on issue 1/);
		assert.throws(() => s.edit(builder, a, { blockedBy: [a] }), /can't be blocked by itself/);
		s.done("engine", a, 12);
		assert.equal(s.page(b).issue.status, "open");
		const c = s.open(builder, { title: "Docs" }).id;
		s.edit(builder, c, { blockedBy: [b] });
		assert.equal(s.page(c).issue.status, "blocked");
		s.edit(builder, c, { blockedBy: [] });
		assert.equal(s.page(c).issue.status, "open");
	});

	it("the first start note sets the Agent when none was set, and the claimer watches", () => {
		const { s } = store();
		const id = s.open(builder, { title: "x" }).id;
		s.claim("engine", id, 3);
		s.claim("fe", id, 4);
		assert.equal(s.page(id).issue.agent, "engine");
		assert.deepEqual(
			s.list({ agent: "engine" }).map((i) => i.id),
			[id],
		);
		assert.ok(s.page(id).issue.watchers.includes("fe"));
	});

	it("drafts are their writer's alone, have no number, make no news, and open as issues", () => {
		const { s } = store();
		const d = s.saveDraft(christopher, { title: "Half a thought" }).id;
		s.saveDraft(christopher, { id: d, title: "A whole thought", agent: "fe" });
		assert.deepEqual(
			s.drafts(christopher).map((x) => x.body),
			[{ title: "A whole thought", agent: "fe" }],
		);
		assert.deepEqual(s.drafts({ person: "u2" }), []);
		assert.throws(() => s.deleteDraft({ person: "u2" }, d), /you have no draft/);
		assert.deepEqual(s.list(), []);
		assert.deepEqual(s.drafts(christopher)[0]!.id, d);
		s.saveDraft(christopher, {});
		const opened = s.openDraft(christopher, d, { description: "added when opening" });
		assert.equal(opened.id, 1);
		assert.deepEqual(opened.news!.to, ["fe"]);
		assert.equal(s.page(1).issue.description, "added when opening");
		assert.equal(s.drafts(christopher).length, 1);
		assert.throws(() => s.openDraft(christopher, s.drafts(christopher)[0]!.id), /the title is missing/);
	});

	it("refuses words a reader can't see, and titles over more than one line", () => {
		const { s } = store();
		assert.throws(
			() => s.open(builder, { title: "fine\u{E0041}" }),
			/a tag character \(U\+E0000-E007F\) at character 5/,
		);
		assert.throws(() => s.open(builder, { title: "one\ntwo" }), /the title is one line/);
		assert.throws(() => s.open(builder, { title: "x", description: "a\u202Eb" }), /bidirectional/);
		const id = s.open(builder, { title: "x", description: "two\nlines\tand a tab" }).id;
		assert.throws(() => s.comment(builder, id, { text: "hi\u200B" }), /zero-width/);
		assert.throws(() => s.edit(builder, id, { title: "a\nb" }), /one line/);
		assert.throws(() => s.open(builder, { title: "x", notify: ["fe\nengine"] }), /one line/);
	});

	it("routes: edit, and drafts read and written by their writer", async () => {
		const { s } = store();
		const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
			issuesRoute(
				s,
				new Request(`https://issues.internal${path}`, {
					method,
					headers,
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				}),
			).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
		const title400 = await call("POST", "/p/web/a/fe/issue", { title: "x\u{E0001}" });
		assert.equal(title400.status, 400);
		assert.match(title400.json.error, /tag character/);
		assert.equal((await call("POST", "/p/web/a/fe/issue", { title: "a\nb" })).status, 400);
		await call("POST", "/p/web/a/fe/issue", { title: "Sign-in" });
		const edited = await call("POST", "/p/web/a/lead/issue/1/edit", { title: "Sign-in flow" });
		assert.equal(edited.status, 200);
		assert.deepEqual(edited.json.notified, ["fe"]);
		const saved = await call("POST", "/p/web/a/lead/draft", { title: "Later" });
		assert.equal((await call("GET", "/p/web/a/lead/drafts", undefined)).json.drafts[0].body.title, "Later");
		assert.deepEqual((await call("GET", "/p/web/a/fe/drafts")).json.drafts, []);
		// A read naming nobody sees no one's drafts.
		assert.equal((await call("GET", "/p/web/drafts")).status, 403);
		assert.equal((await call("POST", `/p/web/a/fe/draft/${saved.json.id}/delete`)).status, 404);
		assert.equal((await call("POST", `/p/web/a/lead/draft/${saved.json.id}/open`, {})).json.id, 2);
		assert.deepEqual((await call("GET", "/p/web/a/lead/drafts", undefined)).json.drafts, []);
	});
});

describe("issues: each writer's limit", () => {
	it("one write past the per-minute limit gets 429 with Retry-After; another writer isn't affected", async () => {
		const { s, tick } = store();
		const call = (path: string, body: unknown, agent: string) =>
			issuesRoute(
				s,
				new Request(`https://issues.internal${path.replace("/p/web/", `/p/web/a/${agent}/`)}`, {
					method: "POST",
					body: JSON.stringify(body),
				}),
			);
		assert.equal((await call("/p/web/issue", { title: "One" }, "u1")).status, 200);
		for (let i = 0; i < WRITES_PER_MINUTE - 1; i++)
			assert.equal((await call("/p/web/issue/1/comment", { text: `c${i}` }, "u1")).status, 200);
		// A refused write doesn't count, and drafts make no news, so they don't either.
		assert.equal((await call("/p/web/draft", { title: "later" }, "u1")).status, 200);
		const over = await call("/p/web/issue/1/comment", { text: "over limit" }, "u1");
		assert.equal(over.status, 429);
		assert.match(
			((await over.json()) as { error: string }).error,
			new RegExp(`at most ${WRITES_PER_MINUTE} issue writes a minute`),
		);
		assert.equal(over.headers.get("Retry-After"), "60");
		assert.equal((await call("/p/web/issue/1/comment", { text: "mine" }, "u2")).status, 200);
		tick(60_000);
		assert.equal((await call("/p/web/issue/1/comment", { text: "a minute on" }, "u1")).status, 200);
	});
});

describe("issues: labels", () => {
	it("set on open, changed by edit, filtered by, and listed with counts", () => {
		const { s } = store();
		const a = s.open(builder, { title: "Sync is slow", labels: ["friction", "client", "friction"] }).id;
		const b = s.open(builder, { title: "Blame past a reformat", labels: ["friction", "engine"] }).id;
		s.open(builder, { title: "Logo" });
		assert.deepEqual(s.page(a).issue.labels, ["client", "friction"]);
		assert.deepEqual(
			s.list({ labels: ["friction"] }).map((i) => i.id),
			[b, a],
		);
		assert.deepEqual(
			s.list({ labels: ["friction", "client"] }).map((i) => i.id),
			[a],
		);
		// A label-only edit tells nobody unless asked; it's in the activity.
		const quiet = s.edit(christopher, a, { addLabels: ["good-first-issue"], removeLabels: ["client"] });
		assert.deepEqual(quiet.notified, []);
		assert.deepEqual(s.page(a).issue.labels, ["friction", "good-first-issue"]);
		assert.deepEqual(s.page(a).edits.at(-1)!.changes.labels, {
			from: ["client", "friction"],
			to: ["friction", "good-first-issue"],
		});
		const told = s.edit(christopher, a, { labels: ["friction"], notify: true });
		assert.match(told.news!.text, /labels friction$/);
		s.drop(builder, b);
		assert.deepEqual(s.labelsInUse(), [
			{ label: "engine", open: 0, total: 1 },
			{ label: "friction", open: 1, total: 2 },
		]);
		assert.throws(() => s.edit(builder, a, { addLabels: ["friction"] }), /changes nothing/);
		assert.throws(() => s.open(builder, { title: "x", labels: ["two words"] }), /isn't a label/);
		// Sent straight to the Worker, upper case and a zero-width are refused, not changed.
		assert.throws(
			() => s.open(builder, { title: "x", labels: ["Friction"] }),
			(e: { status?: number }) => e.status === 400,
		);
		assert.throws(
			() => s.open(builder, { title: "x", labels: ["fric​tion"] }),
			(e: { status?: number }) => e.status === 400,
		);
		assert.throws(() => s.open(builder, { title: "x", labels: ["x".repeat(41)] }), /isn't a label/);
		assert.throws(() => s.edit(builder, a, { labels: [], addLabels: ["x"] }), /one or the other/);
		assert.throws(() => s.list({ labels: ["Bad Label"] }), /isn't a label/);
	});

	it("routes: ?label= filters, GET labels lists, and drafts keep labels", async () => {
		const { s } = store();
		const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
			issuesRoute(
				s,
				new Request(`https://issues.internal${path}`, {
					method,
					headers,
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				}),
			).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
		await call("POST", "/p/web/a/fe/issue", { title: "One", labels: ["friction"] });
		await call("POST", "/p/web/a/fe/issue", { title: "Two", labels: ["friction", "client"] });
		const both = await call("GET", "/p/web/issues?label=friction,client");
		assert.deepEqual(
			both.json.issues.map((i: { title: string }) => i.title),
			["Two"],
		);
		assert.equal((await call("GET", "/p/web/issues?label=friction&label=client")).json.issues.length, 1);
		assert.equal((await call("GET", "/p/web/issues?label=Not%20one")).status, 400);
		assert.deepEqual((await call("GET", "/p/web/labels")).json.labels, [
			{ label: "client", open: 1, total: 1 },
			{ label: "friction", open: 2, total: 2 },
		]);
		const edited = await call("POST", "/p/web/a/fe/issue/1/edit", { addLabels: ["client"] });
		assert.equal(edited.status, 200);
		const d = await call("POST", "/p/web/a/fe/draft", { title: "Later", labels: ["friction"] });
		const opened = await call("POST", `/p/web/a/fe/draft/${d.json.id}/open`, {});
		assert.deepEqual((await call("GET", `/p/web/issue/${opened.json.id}`)).json.issue.labels, ["friction"]);
	});
});

describe("issues: a project's labels are capped", () => {
	it("a new label past 200 distinct ones is refused; one in use still goes on", () => {
		const { s } = store();
		const ids: number[] = [];
		for (let i = 0; i < 10; i++)
			ids.push(s.open(builder, { title: `t${i}`, labels: Array.from({ length: 20 }, (_, j) => `l${i * 20 + j}`) }).id);
		assert.equal(s.labelsInUse().length, 200);
		assert.throws(
			() => s.open(builder, { title: "one more", labels: ["l-new"] }),
			/this project has 200 labels, and 200 is the most/,
		);
		assert.throws(
			() => s.edit(builder, s.open(builder, { title: "room" }).id, { addLabels: ["l-new"] }),
			/200 is the most/,
		);
		assert.equal(s.edit(builder, ids[1]!, { addLabels: ["l0"], removeLabels: ["l20"] }).notified.length, 0);
	});
});

describe("issues: when an ask was first listed to its reader", () => {
	const get = (s: IssuesStore, path: string, headers: Record<string, string> = {}) =>
		issuesRoute(s, new Request(`https://issues.internal${path}`, { headers }));

	it("an agent's own waiting marks what it lists as seen, and says null for what it saw first just now", async () => {
		const { s, tick } = store();
		const id = s.ask(builder, { of: "security", question: "Is the cookie set right?" }).id;
		const read = async (path: string) =>
			((await (await get(s, path)).json()) as { asks: { id: number; seen: number | null }[] }).asks;
		assert.deepEqual(await read("/p/abso/waiting?of=security"), [{ ...s.waiting("security")[0]!, seen: null }]);
		assert.equal(s.waiting("security")[0]!.seen, null, "a read of someone else's list marks nothing");
		tick();
		const first = await read("/p/abso/a/security/waiting");
		assert.equal(first[0]!.seen, null);
		const at = s.waiting("security")[0]!.seen;
		assert.equal(at, Date.parse("2026-10-07T20:00:01Z"));
		tick();
		assert.equal((await read("/p/abso/a/security/waiting"))[0]!.seen, at, "the first time stays");
		assert.equal(first[0]!.id, id);
	});

	it("another agent's read of the list marks nothing", async () => {
		const { s } = store();
		s.ask(builder, { of: "security", question: "Take abso.dev?" });
		await get(s, "/p/abso/a/fe/waiting");
		assert.equal(s.waiting("security")[0]!.seen, null);
		await get(s, "/p/abso/a/security/waiting");
		assert.notEqual(s.waiting("security")[0]!.seen, null);
	});
});
