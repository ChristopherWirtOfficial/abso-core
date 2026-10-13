// The --server flag (abso-core issue 10). Every command that talks to a server takes --server <url>, parsed and
// checked here the same way for all of them:
//   - A command that works on a joined folder ("folder") talks only to that folder's server. --server there must
//     name that same server; another one is refused, never swapped in, so the folder's work and key never go to
//     a server it wasn't joined on. Outside a joined folder it is refused too, with how to join one there.
//   - A command that picks a server for itself ("chosen": join, init, login, whoami and the rest about this box)
//     uses the one --server names, as given.
//   - A command that works on this machine only ("local") takes no --server, and says so.
// A value that isn't an http or https URL (a user name, a query or a fragment included) is refused before any
// call, as is an empty one.

import { readFileSync } from "node:fs";
import { type Parsed, UsageError } from "./args.ts";
import { configPath, findRoot } from "./config.ts";
import { serverBase } from "./core.ts";

/** How a command uses a server: its joined folder's, one it picks, or none. */
export type ServerUse = "folder" | "chosen" | "local";

/** The commands that pick a server for themselves rather than use a joined folder's. */
const CHOSEN: ReadonlySet<string> = new Set([
	"init",
	"join",
	"key",
	"login",
	"box",
	"whoami",
	"doctor",
	"logout",
	"orgs",
	"org",
]);

/** The commands that never talk to a server. */
const LOCAL: ReadonlySet<string> = new Set(["skill", "check-ignore", "pause", "resume", "fix-eol"]);

/** How `command` uses a server. Anything not named above works on a joined folder. */
export function serverUse(command: string): ServerUse {
	return CHOSEN.has(command) ? "chosen" : LOCAL.has(command) ? "local" : "folder";
}

const EXAMPLE = "https://api.abso.dev";

/** `value` as a server, or a refusal naming where it came from (--server, ABSO_SERVER). */
export function checkedServer(value: string, from: string): string {
	const v = value.trim();
	if (v === "") throw new UsageError(`${from} needs a server's URL, like ${EXAMPLE}`);
	if (serverBase(v) === undefined)
		throw new UsageError(
			`${from} takes an http or https URL with no user name, query or fragment, like ${EXAMPLE} (got ${JSON.stringify(value)})`,
		);
	return v;
}

/** The server --server names, checked, or undefined when it isn't given. */
export function serverFlag(args: Parsed): string | undefined {
	const v = args.flags.get("server");
	return typeof v === "string" ? checkedServer(v, "--server") : undefined;
}

/** Whether two servers are the same one: the same scheme, host, port and path, ignoring case and a trailing slash. */
export function sameServer(a: string, b: string): boolean {
	return (serverBase(a) ?? a.trim()) === (serverBase(b) ?? b.trim());
}

/** The server in the .abso/config.json of the folder `cwd` is in, or undefined outside one (or when it can't be read). */
export function folderServer(cwd: string): string | undefined {
	const root = findRoot(cwd);
	if (root === undefined) return undefined;
	try {
		const server = (JSON.parse(readFileSync(configPath(root), "utf8")) as { server?: unknown }).server;
		return typeof server === "string" && server !== "" ? server : undefined;
	} catch {
		return undefined;
	}
}

/**
 * For a command that works on a joined folder: refuses a --server that isn't the folder's own server, and one
 * given outside a joined folder. Nothing is sent before this.
 */
export function checkFolderServer(command: string, flag: string, cwd: string): void {
	const own = folderServer(cwd);
	if (own === undefined)
		throw new UsageError(
			`abso ${command} works on a joined folder, and ${cwd} isn't in one. To work with ${flag}: abso join <project> --server ${flag}, or abso init --server ${flag} for a new project.`,
		);
	if (!sameServer(own, flag))
		throw new UsageError(
			`this folder is joined on ${own}, not ${flag}, so abso ${command} won't send its work or key there. Run it in a folder joined on ${flag} (abso join <project> --server ${flag}).`,
		);
}

/** What help says about --server for a command, the same words for every command of a kind. */
export function serverHelp(command: string): string | undefined {
	switch (serverUse(command)) {
		case "local":
			return undefined;
		case "folder":
			return "--server <url>: this folder's own server, which it uses anyway. Another server is refused, never swapped in, so the folder's work and key go only to the server it was joined on.";
		case "chosen":
			return command === "key"
				? "--server <url>: the server the key is for; without it, this folder's. It is used as given, never swapped for another."
				: "--server <url>: the server to use, as given, never swapped for another. Each server gets only its own sign-in.";
	}
}

/** The refusal for --server on a command that works on this machine only. */
export function localRefusal(command: string): string {
	return `abso ${command} works on this machine only and talks to no server, so it takes no --server`;
}
