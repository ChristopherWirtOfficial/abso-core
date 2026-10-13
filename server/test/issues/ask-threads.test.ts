// Ask threads: replies from either side, whose turn it is, the
// asks someone sent, one ask with its thread, and asks going only to seats.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { issuesRoute } from "../../src/issues/routes.ts";
import { closestSeat, seatRefusal } from "../../src/issues/seats.ts";
import { IssuesStore, type Sql } from "../../src/issues/store.ts";

function sql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec: (q, ...b) => {
			if (/^\s*CREATE\b/i.test(q)) {
				db.exec(q);
				return { toArray: () => [] };
			}
			const rows = db.prepare(q).all(...(b as (string | number | null)[]));
			return { toArray: () => rows };
		},
	};
}

function store(): { s: IssuesStore; db: Sql; tick: (ms?: number) => void } {
	let t = Date.parse("2026-10-10T05:00:00Z");
	const db = sql();
	IssuesStore.createTables(db);
	return { s: new IssuesStore(db, () => t), db, tick: (ms = 1000) => void (t += ms) };
}

const desk = { agent: "desk" };
const fay = { agent: "fay" };

describe("ask threads", () => {
	it("replies from both sides, oldest first; a question back waits on the asker until they reply", () => {
		const { s, tick } = store();
		const id = s.open(desk, { title: "Sync is slow" }).id;
		const ask = s.ask(desk, { issue: id, of: "fay", question: "Which way?" });
		assert.equal(s.askThread(ask.id).waitingOn, "fay");

		tick();
		s.ack(fay, ask.id, { note: "ok, let me check" });
		tick();
		const back = s.reply(fay, ask.id, { text: "staging or live?", question: true });
		assert.equal(back.ask.waitingOn, "desk");
		assert.deepEqual(back.news.to, ["desk"]);
		assert.equal(
			back.news.text,
			`fay replied on ask ${ask.id} (issue ${id}) with a question: "staging or live?" It waits on you. abso ask ${ask.id} shows the thread.`,
		);
		assert.deepEqual(
			back.ask.replies!.map((r) => [r.by, r.text, r.question === true]),
			[
				["fay", "ok, let me check", false],
				["fay", "staging or live?", true],
			],
		);
		// It's in the asker's waiting list now, not the one asked's, and the issue waits on the asker.
		assert.deepEqual(
			s.waiting("desk").map((a) => a.id),
			[ask.id],
		);
		assert.deepEqual(s.waiting("fay"), []);
		assert.deepEqual(s.page(id).issue.waitingOn, ["desk"]);

		tick();
		const handed = s.reply(desk, ask.id, { text: "live" });
		assert.equal(handed.ask.waitingOn, "fay");
		assert.deepEqual(handed.news.to, ["fay"]);
		assert.match(handed.news.text, /^desk replied on ask \d+ \(issue \d+\): "live" It waits on you\./);
		assert.deepEqual(
			s.waiting("fay").map((a) => a.id),
			[ask.id],
		);

		// A plain reply from the one asked leaves the turn where it is.
		assert.equal(s.reply(fay, ask.id, { text: "deploying" }).ask.waitingOn, "fay");

		// Answering closes it; a reply after still lands, and waits on nobody.
		s.answer(fay, ask.id, { words: "done on live" });
		const after = s.reply(desk, ask.id, { text: "thanks" });
		assert.equal(after.ask.waitingOn, null);
		assert.equal(after.ask.answer!.words, "done on live");
		assert.equal(after.ask.replies!.length, 5);
		assert.equal(s.page(id).asks[0]!.replies!.length, 5);
		assert.deepEqual(s.waiting("fay"), []);
		assert.deepEqual(s.waiting("desk"), []);
	});

	it("only the two reply, with words, on an ask that exists", () => {
		const { s } = store();
		const ask = s.ask(desk, { of: "fay", question: "Pick one" });
		assert.throws(
			() => s.reply({ agent: "eve" }, ask.id, { text: "me too" }),
			(e: { status?: number; message: string }) =>
				e.status === 403 && /between desk and fay; only they reply on it/.test(e.message),
		);
		assert.throws(
			() => s.reply(fay, 99, { text: "x" }),
			(e: { status?: number }) => e.status === 404,
		);
		assert.throws(() => s.reply(fay, ask.id, { text: "" }));
		assert.throws(() => s.reply(fay, ask.id, {}));
	});

	it("an ack with no note adds no reply; ack's note is the thread's first", () => {
		const { s } = store();
		const ask = s.ask(desk, { of: "fay", question: "Pick one" });
		assert.deepEqual(s.ack(fay, ask.id, {}).ask.replies, []);
		assert.equal(s.ack(fay, ask.id, { note: "soon" }).ask.replies![0]!.text, "soon");
	});

	it("asked lists what someone sent: open oldest first, then the latest answered", () => {
		const { s, tick } = store();
		const a = s.ask(desk, { of: "fay", question: "One" });
		tick();
		const b = s.ask(desk, { of: "fay", question: "Two" });
		tick();
		const c = s.ask(desk, { of: "fay", question: "Three" });
		s.ask(fay, { of: "desk", question: "Not desk's" });
		s.answer(fay, b.id, { words: "yes" });
		assert.deepEqual(
			s.asked("desk").map((x) => x.id),
			[a.id, c.id, b.id],
		);
	});
});

describe("ask thread routes", () => {
	const call = (
		s: IssuesStore,
		method: string,
		path: string,
		body?: unknown,
		seatError?: (of: string) => Promise<string | null>,
	) =>
		issuesRoute(
			s,
			new Request(`https://issues.internal${path}`, {
				method,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}),
			seatError,
		).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

	it("POST a/<agent>/reply/N, GET ask/N, GET a/<agent>/asked and asked?by=", async () => {
		const { s } = store();
		const ask = s.ask(desk, { of: "fay", question: "Which way?" });
		const r = await call(s, "POST", `/p/web/a/fay/reply/${ask.id}`, { text: "live?", question: true });
		assert.equal(r.status, 200, JSON.stringify(r.json));
		assert.equal(r.json.ask.waitingOn, "desk");
		const one = await call(s, "GET", `/p/web/ask/${ask.id}`);
		assert.equal(one.json.ask.replies[0].text, "live?");
		assert.equal((await call(s, "GET", "/p/web/ask/99")).status, 404);
		const mine = await call(s, "GET", "/p/web/a/desk/asked");
		assert.deepEqual(
			mine.json.asks.map((a: { id: number }) => a.id),
			[ask.id],
		);
		assert.equal((await call(s, "GET", "/p/web/asked?by=desk")).json.asks.length, 1);
		assert.equal((await call(s, "GET", "/p/web/asked")).status, 400);
	});

	it("a new ask to a name that isn't a seat is refused, naming the closest seat", async () => {
		const { s } = store();
		const seats = ["cloud", "agentvcs", "pinch", "infra-ops"];
		const check = async (of: string) => (of.startsWith("person:") ? null : seatRefusal(of, "web", seats));
		const refused = await call(s, "POST", "/p/web/a/desk/ask", { of: "abso - Cloud Infra Lead", question: "Q" }, check);
		assert.equal(refused.status, 400);
		assert.equal(
			refused.json.error,
			'"abso - Cloud Infra Lead" isn\'t an agent in web, so nobody would hear the ask; did you mean cloud? abso status lists the agents.',
		);
		assert.deepEqual(s.asked("desk"), []);
		assert.equal((await call(s, "POST", "/p/web/a/desk/ask", { of: "cloud", question: "Q" }, check)).status, 200);
	});

	it("closestSeat: the same name written another way, a seat the name holds, then a near spelling", () => {
		const seats = ["cloud", "agentvcs", "pinch", "infra-ops", "security-2"];
		assert.equal(closestSeat("Agent VCS", seats), "agentvcs");
		assert.equal(closestSeat("abso - Cloud Infra Lead", seats), "cloud");
		assert.equal(closestSeat("Security 2", seats), "security-2");
		assert.equal(closestSeat("pnich", seats), "pinch");
		assert.equal(closestSeat("infraops", seats), "infra-ops");
		assert.equal(closestSeat("zzzzzz", seats), null);
		assert.equal(seatRefusal("pinch", "web", seats), null);
		assert.match(
			seatRefusal("nobody", "web", seats)!,
			/isn't an agent in web, so nobody would hear the ask\. abso status/,
		);
	});
});
