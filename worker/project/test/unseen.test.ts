// Text the engine keeps and prints can't hold characters a reader can't see
// (abso issue 276): a version message with an escape sequence would run in
// every terminal that shows `abso log` or news.

import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../http.ts";
import type { ProjectCalls } from "../project-api.ts";
import { unseenIn } from "../unseen.ts";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const CR = String.fromCharCode(0x0d);

test("unseenIn: ESC, C1, BEL and bidi overrides are found; newline, tab and CRLF pass", () => {
	assert.equal(unseenIn(`Fix the parser\n\nDetails\twith a tab${CR}\nand CRLF.`), null);
	assert.equal(unseenIn(`ok ${ESC}]52;c;aGk=${BEL}`), "a control character at character 4");
	assert.equal(unseenIn(`${CSI}31m`), "a control character at character 1");
	assert.equal(unseenIn(`a${CR}b`), "a control character at character 2");
	assert.match(unseenIn(`abc${RLO}def`)!, /bidirectional embedding or override/);
	assert.equal(unseenIn(`emoji 🎉 counts as one character ${ESC}`), "a control character at character 33");
});

test("publish, amend, land, starting notes and announcements refuse unseen characters before the engine sees them", () => {
	// A stand-in for the engine: it records each call that gets through.
	const calls: string[] = [];
	const project = new Proxy({} as ProjectCalls, {
		get:
			(_, name) =>
			(...args: unknown[]) => {
				if (name === "exists") return true;
				calls.push(`${String(name)} ${JSON.stringify(args[1])}`);
				return { ok: true };
			},
	});
	const osc8 = `Fix ${ESC}]8;;https://example.invalid${BEL}here${ESC}]8;;${BEL}`;
	const refused = answer(project, "publish", "ann", { message: osc8 });
	assert.equal(refused.status, 400);
	assert.match(JSON.stringify(refused.body), /the message holds a control character at character 5/);
	assert.equal(answer(project, "amend", "ann", { message: `Two ${ESC}[2J` }).status, 400);
	assert.equal(answer(project, "land", "ann", { message: `Land ${CSI}1m` }).status, 400);
	assert.equal(answer(project, "starting", "ann", { text: `on ${RLO}this` }).status, 400);
	assert.equal(answer(project, "announce", "ann", { text: `hi ${BEL}` }).status, 400);
	assert.deepEqual(calls, [], "none reached the engine");

	const windows = `Two${CR}\n${CR}\nWritten on Windows.`;
	assert.equal(answer(project, "publish", "ann", { message: windows }).status, 200);
	assert.equal(answer(project, "starting", "ann", { text: "on the parser" }).status, 200);
	assert.deepEqual(calls, [`publish ${JSON.stringify(windows)}`, 'starting "on the parser"']);
});
