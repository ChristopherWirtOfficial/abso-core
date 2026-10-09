// abso-view against the engine: the server and the folder are answered here.

import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const STATUS = {
	version: 7,
	agents: [
		{
			agent: "me",
			draft: null,
			base: 5,
			draftChanges: 3,
			files: ["src/a.ts", "src/b.ts"],
			parked: [{ draft: "exp", draftChanges: 2 }],
		},
		{ agent: "bob", draft: null, base: 7, draftChanges: 1, files: ["src/a.ts"] },
	],
	drafts: [],
};
const WHERE = {
	version: 7,
	files: {
		"src/a.ts": [
			{ agent: "me", lines: [[1, 2]], shared: [[1, 2]], changes: 2, lastEdit: 0 },
			{ agent: "bob", lines: [[9, 9]], shared: [[9, 9]], changes: 1, lastEdit: 0 },
		],
		"src/b.ts": [{ agent: "me", lines: [[1, 1]], shared: [[1, 1]], changes: 1, lastEdit: 0 }],
	},
};
const NEWS = "2026-10-05T01:00:00.000Z\tbob changed parse, which src/a.ts uses.\n";

/** The world beneath the plugin: a session in /w/proj/src, an abso folder at /w/proj when `inFolder`. */
function world(on: On, inFolder: boolean) {
	mock.env(on, { AVCS_TOKEN: "test-token" });
	const clock = mock.clock(on, { now: 1_000_000 });
	const fetched: string[] = [];
	const statuses: (string | undefined)[] = [];
	const opened: string[] = [];
	const reads: string[] = [];
	on("session.start", (_$, e) => ({ cwd: (e as { cwd?: string }).cwd ?? "/w/proj/src" }));
	on("session.cwd", () => ({ value: "/w/proj/src" }));
	on("command.register", (_$, e) => ({ value: { command: e.name } }));
	on("fs.read", (_$, e) => {
		// The engine hands hooks the path resolved for this machine (C:\w\proj on Windows).
		const path = e.path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
		reads.push(path);
		if (inFolder && path === "/w/proj/.abso/config.json")
			return { value: JSON.stringify({ server: "https://avcs.test", project: "p", agent: "me" }) };
		if (inFolder && path === "/w/proj/.abso/news.log") return { value: NEWS };
		return { deny: `ENOENT: ${e.path}` };
	});
	on("http.fetch", (_$, e) => {
		fetched.push(e.url);
		const body = e.url.endsWith("/status") ? STATUS : WHERE;
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } };
	});
	on("ui.status", (_$, e) => {
		statuses.push(e.text);
		return { value: undefined };
	});
	on("ui.open", (_$, e) => {
		opened.push(e.id);
		return { value: { isPlaced: true } };
	});
	return { clock, fetched, statuses, opened, reads };
}

test("outside an abso folder it asks nothing and shows nothing", async ($, on) => {
	const w = world(on, false);
	await $.session.start({ cwd: "/w/proj/src" });
	await w.clock.advance(120_000);
	expect(w.fetched).toEqual([]);
	expect(w.statuses).toEqual([]);
});

test("in an abso folder it keeps a status line, and refreshes on a timer", async ($, on) => {
	const w = world(on, true);
	await $.session.start({ cwd: "/w/proj/src" });
	await w.clock.advance(1);
	expect(w.fetched).toEqual(["https://avcs.test/p/p/status", "https://avcs.test/p/p/where"]);
	expect(w.statuses.at(-1)).toBe(
		"abso: shared · 2 files unpublished · shared is 2 ahead (abso sync) · bob also on your files · 1 news item (/abso-view)",
	);
	await w.clock.advance(31_000);
	expect(w.fetched.length).toBe(4);
});

test("the pane shows the space, the draft, who else is on the files, and news", async ($, on) => {
	const w = world(on, true);
	await $.session.start({ cwd: "/w/proj/src" });
	await w.clock.advance(1);
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await $.ui.mount({
			plugin: "abso-view",
			surface,
			component: "Pane",
			requestId: "abso-view",
			props: { title: "avcs", isFocused: false, bodyColumns: 80, placement: "dock" } as never,
		});
		expect(await ui.find({ text: /Working in shared, at version 7/ })).toBeDefined();
		expect(await ui.find({ text: /3 changes in 2 files/ })).toBeDefined();
		expect(await ui.find({ text: /bob: src\/a\.ts/ })).toBeDefined();
		expect(await ui.find({ text: /Parked: exp \(2 changes\)/ })).toBeDefined();
		expect(await ui.find({ text: /bob changed parse/ })).toBeDefined();
	}
});

test("/abso-view opens the pane, and the status line stops counting the news it showed", async ($, on) => {
	const w = world(on, true);
	await $.session.start({ cwd: "/w/proj/src" });
	await w.clock.advance(1);
	expect(w.statuses.at(-1)).toContain("1 news item");
	const answer = await $.command.run({ command: "abso-view", args: "" } as never);
	expect(answer).toMatchObject({ text: "Opened the abso view." });
	expect(w.opened).toEqual(["abso-view"]);
	expect(w.statuses.at(-1)).not.toContain("news");
});

test("an edit brings a refresh a few seconds later, not 30", async ($, on) => {
	const w = world(on, true);
	on("tool.call", () => ({ result: { isError: false, text: "ok" } }) as never);
	await $.session.start({ cwd: "/w/proj/src" });
	await w.clock.advance(1);
	expect(w.fetched.length).toBe(2);
	await $.tool.call({
		tool: "Edit",
		tool_use_id: "t1",
		file_path: "/w/proj/src/a.ts",
		old_string: "a",
		new_string: "b",
	} as never);
	await w.clock.advance(6_000);
	expect(w.fetched.length).toBe(4);
});
