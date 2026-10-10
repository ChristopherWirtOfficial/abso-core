// What the client prints can't drive the terminal: colors pass to a terminal
// with NO_COLOR unset, and every other control character shows as text.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { colorsPass, terminalText } from "../src/terminal-text.ts";

const ESC = "\x1b";

describe("terminalText", () => {
	it("leaves plain text, tabs, newlines and CRLF alone", () => {
		const plain = "abso 72\tpublished\nnext line: ü, 中文, 🙂\r\n";
		assert.equal(terminalText(plain, true), plain);
		assert.equal(terminalText(plain, false), plain);
	});

	it("keeps colors only when they pass, and drops them quietly otherwise", () => {
		const red = `${ESC}[31mfailed${ESC}[0m and ${ESC}[1;38;5;208mbold${ESC}[m`;
		assert.equal(terminalText(red, true), red);
		assert.equal(terminalText(red, false), "failed and bold");
	});

	it("shows OSC 52 (the clipboard) and OSC 8 (links) as text, with or without colors", () => {
		const clip = `${ESC}]52;c;ZWNobyBoaQ==\x07`;
		assert.equal(terminalText(clip, true), "\\x1b]52;c;ZWNobyBoaQ==\\x07");
		const link = `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`;
		assert.equal(terminalText(link, true), "\\x1b]8;;https://evil.example\\x1b\\click\\x1b]8;;\\x1b\\");
	});

	it("shows other CSI, DCS and the rest of C0 and C1 as text", () => {
		assert.equal(terminalText(`${ESC}[2J${ESC}[H`, true), "\\x1b[2J\\x1b[H");
		assert.equal(terminalText(`${ESC}P1$r${ESC}\\`, true), "\\x1bP1$r\\x1b\\");
		assert.equal(terminalText("over\rwrite\b\x00\x7f", true), "over\\x0dwrite\\x08\\x00\\x7f");
		assert.equal(terminalText("\u009b31m\u0090x\u009c", true), "\\u009b31m\\u0090x\\u009c");
		// An SGR with anything but digits, ; and : isn't one.
		assert.equal(terminalText(`${ESC}[31;"m`, true), '\\x1b[31;"m');
	});

	it("colors pass to a terminal only, and never with NO_COLOR set", () => {
		assert.equal(colorsPass({ isTTY: true }, {}), true);
		assert.equal(colorsPass({ isTTY: true }, { NO_COLOR: "1" }), false);
		assert.equal(colorsPass({ isTTY: true }, { NO_COLOR: "" }), true);
		assert.equal(colorsPass({ isTTY: false }, {}), false);
		assert.equal(colorsPass({}, {}), false);
	});

	it("the client's own output goes through it: an error naming text with escapes prints them as text", async () => {
		const home = mkdtempSync(join(tmpdir(), "abso-test-terminal-"));
		try {
			// An unknown command: the error names it, escape and all.
			const dir = mkdtempSync(join(home, "x"));
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USERPROFILE: home,
				AVCS_SERVERS_FILE: "no-servers.json",
			};
			if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
			const client = resolve(import.meta.dirname, "..", "abso.ts");
			const run = await new Promise<{ stdout: string; stderr: string }>((done) =>
				execFile(process.execPath, [client, `frob${ESC}]52;c;aGk=\x07`], { cwd: dir, env }, (_e, stdout, stderr) =>
					done({ stdout, stderr }),
				),
			);
			assert.doesNotMatch(run.stdout + run.stderr, /\x1b/);
			assert.match(run.stderr, /frob\\x1b\]52;c;aGk=\\x07/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
