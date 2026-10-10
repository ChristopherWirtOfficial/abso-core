// Opening a page in the person's own browser, as `gh auth login` and `wrangler login` do.
// `abso login` opens the approve page with the code already in it, and still prints the
// link and the code: an open that fails, or is skipped, is silent, and the printed link stands.

import { spawn } from "node:child_process";

/** Why not to open a browser here, or null to open one. */
export function browserSkip(env: Readonly<Record<string, string | undefined>>, platform: string): string | null {
	if (env.ABSO_NO_BROWSER) return "ABSO_NO_BROWSER is set";
	// Over SSH the browser would open on the far machine's desktop, if it has one.
	if (env.SSH_CONNECTION || env.SSH_TTY) return "this is an SSH session";
	if (env.CI && env.CI !== "false" && env.CI !== "0") return "this is CI";
	if (platform !== "win32" && platform !== "darwin" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
		return "there's no display";
	return null;
}

/**
 * The program that opens `url` in the default browser, and its arguments. No shell, so nothing in the url is
 * read as shell syntax. On Windows that rules out cmd's start, which cuts a url at its first &.
 */
export function openCommand(url: string, platform: string): [string, string[]] {
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	if (platform === "darwin") return ["open", [url]];
	return ["xdg-open", [url]];
}

/** Only web pages are opened: a link from a server is never handed to the desktop as a file or another program. */
export function isWebLink(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}

/**
 * Opens `url` in the default browser and doesn't wait. Answers whether it started an opener; a failure
 * (no such program, refused) is silent.
 */
export function openInBrowser(url: string, platform: string = process.platform, run: typeof spawn = spawn): boolean {
	if (!isWebLink(url)) return false;
	const [command, args] = openCommand(url, platform);
	try {
		const child = run(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
