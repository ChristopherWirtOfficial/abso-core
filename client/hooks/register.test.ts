// The abso mod's news poll, against the engine (claude plugin test client):
// an agent that isn't editing still gets announcements, within 30 seconds.

import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

/** The world beneath the mod: a chat in /w/p, an abso folder when `inFolder`, and a server with `news` waiting. */
function world(on: On, inFolder: boolean, news: string[][]) {
	mock.env(on, { AVCS_TOKEN: "test-token" });
	const clock = mock.clock(on, { now: 1_000_000 });
	const asked: string[] = [];
	const auth: string[] = [];
	const clients: string[] = [];
	const appended: string[] = [];
	const written = new Map<string, string>();
	// The engine hands hooks paths resolved for this machine (C:\w\p on Windows).
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
	on("session.start", (_$, e) => ({ cwd: (e as { cwd?: string }).cwd ?? "/w/p" }));
	on("session.cwd", () => ({ value: "/w/p" }));
	on("fs.exists", (_$, e) => ({ value: inFolder && norm(e.path) === "/w/p/.abso/config.json" }));
	on("fs.read", (_$, e) => {
		const path = norm(e.path);
		if (inFolder && path === "/w/p/.abso/config.json")
			return { value: JSON.stringify({ server: "https://avcs.test", project: "p", agent: "bob" }) };
		if (written.has(path)) return { value: written.get(path)! };
		return { deny: `ENOENT: ${path}` };
	});
	on("fs.write", (_$, e) => {
		written.set(norm(e.path), e.text);
		return { value: undefined };
	});
	on("http.fetch", (_$, e) => {
		asked.push(e.url);
		auth.push((e.init?.headers as Record<string, string> | undefined)?.authorization ?? "none");
		clients.push(String((e.init?.headers as Record<string, string> | undefined)?.["x-avcs-client"]));
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ news: news.shift() ?? [] }) } };
	});
	on("session.append", (_$, e) => {
		appended.push((e.message.content as { text: string }[])[0]!.text);
		return { value: { message: e.message, uuid: `u${appended.length}` } } as never;
	});
	return { clock, asked, auth, clients, appended, written };
}

test("the news poll asks every 30 seconds in an abso folder, and keeps each item once", async ($, on) => {
	// The kit has no conversation to append to, so the append itself is checked in a live session (#25);
	// here: the poll's timing, the call, and the news log the view mod reads.
	const w = world(on, true, [["Announcement from lead: stop publishing until v12 lands"], []]);
	await $.session.start({ cwd: "/w/p" });
	await w.clock.advance(29_000);
	expect(w.asked).toEqual([]);
	await w.clock.advance(1_000);
	expect(w.asked).toEqual(["https://avcs.test/p/p/a/bob/news"]);
	// avcs.test isn't a server the token goes to (#30): the call goes out without it.
	expect(w.auth[0]).toBe("none");
	// Which mod asked: avcs-mod/<version> once installed, avcs-mod/checkout from a checkout (#29).
	expect(w.clients[0]).toMatch(/^avcs-mod\/(checkout|\d+\.\d+\.\d+(\+[\w.]+)?)$/);
	await w.clock.advance(30_000);
	expect(w.asked).toHaveLength(2);
	const log = w.written.get("/w/p/.abso/news.log") ?? "";
	expect(log.split("\n").filter((l) => l.includes("Announcement from lead"))).toHaveLength(1);
});

test("outside an abso folder it never asks", async ($, on) => {
	const w = world(on, false, [["should not arrive"]]);
	await $.session.start({ cwd: "/w/p" });
	await w.clock.advance(120_000);
	expect(w.asked).toEqual([]);
	expect(w.appended).toEqual([]);
});

test("an edit that leaves a NUL byte in a text file is not sent, and the log says where", async ($, on) => {
	const w = world(on, true, []);
	w.written.set("/w/p/.abso/known/fuzz.ts", "one\ntwo\nthree\n");
	w.written.set("/w/p/fuzz.ts", "one\ntwo\nth\u0000ree\n");
	on("fs.stat", () => ({ value: { realPath: "/w/p/fuzz.ts" } }) as never);
	on("tool.call", () => ({ result: { isError: false, text: "ok" } }) as never);
	on("session.id", () => ({ value: "sess" }));
	await $.session.start({ cwd: "/w/p" });
	await $.tool.call({
		tool: "Write",
		tool_use_id: "t1",
		file_path: "/w/p/fuzz.ts",
		content: "one\ntwo\nth\u0000ree\n",
	} as never);
	await w.clock.advance(1_000);
	expect(w.written.get("/w/p/.abso/hook.log") ?? "").toContain("not sent: a NUL byte at line 3");
	expect(w.asked.filter((u) => !u.endsWith("/news"))).toEqual([]);
});
