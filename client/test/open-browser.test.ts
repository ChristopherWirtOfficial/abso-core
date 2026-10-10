// Opening the approve page in the person's browser: when it's skipped, which program opens it on each
// platform, and that a failed open is silent.

import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { browserSkip, isWebLink, openCommand, openInBrowser } from "../src/open-browser.ts";

const LINK = "https://abso.dev/login/box?code=WXYZ-BCDF&from=cli";

test("a desktop opens a browser", () => {
	assert.equal(browserSkip({}, "win32"), null);
	assert.equal(browserSkip({}, "darwin"), null);
	assert.equal(browserSkip({ DISPLAY: ":0" }, "linux"), null);
	assert.equal(browserSkip({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), null);
	assert.equal(browserSkip({ CI: "false" }, "darwin"), null, "CI=false isn't CI");
});

test("no browser with ABSO_NO_BROWSER, over SSH, under CI, or on Linux without a display", () => {
	assert.equal(browserSkip({ ABSO_NO_BROWSER: "1" }, "win32"), "ABSO_NO_BROWSER is set");
	assert.equal(browserSkip({ SSH_CONNECTION: "10.0.0.2 51234 10.0.0.1 22" }, "darwin"), "this is an SSH session");
	assert.equal(browserSkip({ SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, "linux"), "this is an SSH session");
	assert.equal(browserSkip({ CI: "true" }, "win32"), "this is CI");
	assert.equal(browserSkip({}, "linux"), "there's no display");
	assert.equal(browserSkip({}, "freebsd"), "there's no display");
});

test("each platform's opener takes the link whole, with no shell to split it at &", () => {
	assert.deepEqual(openCommand(LINK, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", LINK]]);
	assert.deepEqual(openCommand(LINK, "darwin"), ["open", [LINK]]);
	assert.deepEqual(openCommand(LINK, "linux"), ["xdg-open", [LINK]]);
});

test("only web pages are opened", () => {
	assert.equal(isWebLink(LINK), true);
	assert.equal(isWebLink("http://localhost:8787/login/box?code=A"), true);
	for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "C:\\x.exe", "not a link", ""])
		assert.equal(isWebLink(bad), false, bad);
});

type Call = { command: string; args: readonly string[]; options: unknown };
function fakeSpawn(calls: Call[], fail?: "throw" | "error"): typeof spawn {
	return ((command: string, args: readonly string[], options: unknown) => {
		calls.push({ command, args, options });
		if (fail === "throw") throw new Error("spawn EACCES");
		const child = Object.assign(new EventEmitter(), { unref: () => {} });
		if (fail === "error") queueMicrotask(() => child.emit("error", new Error("spawn xdg-open ENOENT")));
		return child;
	}) as unknown as typeof spawn;
}

test("openInBrowser starts the opener without waiting on it, and a failure is silent", async () => {
	const calls: Call[] = [];
	assert.equal(openInBrowser(LINK, "win32", fakeSpawn(calls)), true);
	assert.deepEqual(calls[0]?.command, "rundll32");
	assert.deepEqual(calls[0]?.args, ["url.dll,FileProtocolHandler", LINK]);
	assert.deepEqual(calls[0]?.options, { detached: true, stdio: "ignore", windowsHide: true });

	assert.equal(openInBrowser(LINK, "linux", fakeSpawn([], "throw")), false);
	assert.equal(openInBrowser(LINK, "linux", fakeSpawn([], "error")), true);
	await new Promise((done) => setTimeout(done, 0)); // the error event fires, and nothing throws

	const none: Call[] = [];
	assert.equal(openInBrowser("file:///etc/passwd", "linux", fakeSpawn(none)), false);
	assert.equal(none.length, 0, "a link that isn't a web page never reaches the opener");
});
