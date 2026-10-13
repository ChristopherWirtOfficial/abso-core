// The change count: one number per project's issues that every write an issue read can
// show moves forward, kept by SQLite triggers, so a reader can cache issue reads under it.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { issuesRoute } from "../../src/issues/routes.ts";
import { IssuesStore, type Sql } from "../../src/issues/store.ts";

function sql(): { sql: Sql; db: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	return {
		db,
		sql: {
			exec: (q, ...b) => {
				if (/^\s*CREATE\b/i.test(q)) {
					db.exec(q);
					return { toArray: () => [] };
				}
				const rows = db.prepare(q).all(...(b as (string | number | null)[]));
				return { toArray: () => rows };
			},
		},
	};
}

function store(): { s: IssuesStore; db: DatabaseSync; tick: () => void } {
	let t = Date.parse("2026-10-09T10:00:00Z");
	const { sql: q, db } = sql();
	IssuesStore.createTables(q);
	return { s: new IssuesStore(q, () => t), db, tick: () => void (t += 1000) };
}

const builder = { agent: "builder3" };
const christopher = { person: "u1" };

describe("issues: the change count", () => {
	it("is kept by a trigger on each counted table, for insert, update and delete", () => {
		const { db, s } = store();
		const triggers = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'changed_%'")
			.all();
		assert.equal(triggers.length, 30, "three for each of the ten tables an issue read shows");
		assert.equal(s.changes(), 0);
	});

	it("moves forward on every write an issue read shows, and not on reads, drafts or a repeated waiting", () => {
		const { s, tick } = store();
		let last = s.changes();
		const moved = (what: string) => {
			const n = s.changes();
			assert.ok(n > last, `${what} moved the count (${last} to ${n})`);
			last = n;
		};
		const still = (what: string) => assert.equal(s.changes(), last, `${what} left the count alone`);

		const a = s.open(builder, { title: "Sign-in" }).id;
		moved("opening an issue");
		const b = s.open(builder, { title: "Logo", parent: a }).id;
		moved("opening a child");
		tick();
		s.comment(christopher, a, { text: "Looks right." });
		moved("a comment");
		const q = s.ask(builder, { issue: a, of: "security", question: "Is the cookie set right?", review: true });
		moved("an ask");
		s.waiting("security", "security");
		moved("waiting marking an ask seen");
		s.waiting("security", "security");
		still("a second waiting with nothing new");
		s.answer({ agent: "security" }, q.id, { words: "Yes." });
		moved("an answer");
		s.claim("builder3", b, 12);
		moved("a start note's claim");
		s.edit(christopher, b, { labels: ["design"] });
		moved("a label");
		s.edit(christopher, a, { blockedBy: [b] });
		moved("Blocked by");
		s.markDone(builder, b, 381);
		moved("done in a version");
		const c = s.open(builder, { title: "Footer" }).id;
		s.claim("builder3", c, 13);
		last = s.changes();
		s.unclaim("builder3", c);
		moved("an unclaim");
		s.drop(builder, c);
		moved("a drop");
		s.reopen(builder, c);
		moved("a reopen");

		s.page(a);
		s.list({});
		s.search("sign", 10);
		s.waiting();
		still("reads");
		s.saveDraft(builder, { title: "Mine for now" });
		s.wrote(builder);
		still("a draft and the rate log");
	});

	it("is a route, and every write answers the count it made", async () => {
		const { s } = store();
		const call = async (method: string, path: string, body?: unknown) => {
			const r = await issuesRoute(
				s,
				new Request(`https://issues.internal${path}`, {
					method,
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				}),
			);
			return { status: r.status, json: (await r.json()) as Record<string, unknown> };
		};
		assert.deepEqual((await call("GET", "/p/web/changes")).json, { changes: 0 });
		const opened = await call("POST", "/p/web/a/builder3/issue", { title: "Sign-in" });
		assert.equal(opened.status, 200);
		const after = (await call("GET", "/p/web/changes")).json.changes as number;
		assert.ok(after > 0);
		assert.equal(opened.json.changes, after, "the write's answer is the count a read after it sees");
		const commented = await call("POST", "/p/web/a/builder3/issue/1/comment", { text: "More." });
		assert.ok((commented.json.changes as number) > after);
	});
});
