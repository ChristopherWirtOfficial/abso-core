// The folder's settings (.avcs/config.json), finding the folder that holds
// them, and the token.
//
// The token is never in the folder: it comes from the AVCS_TOKEN environment
// variable, or else from ~/.avcs/token, outside every repo.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { UsageError } from "./args.ts";
import { type MachineServers, machineServers, TOKEN_SERVERS, tokenGoesTo, trustedList } from "./core.ts";
import { homeFile, stateDir } from "./state-dir.ts";

/** What .avcs/config.json holds. */
export interface Settings {
	readonly server: string;
	readonly project: string;
	readonly agent: string;
	/** A label the folder follows (abso follow): every sync moves it to the newest version with that label. */
	readonly follow?: string;
	/** A reader folder (abso join --reader, #37): it reads everything and records nothing; the server refuses its records too. */
	readonly reader?: boolean;
}

export interface Config extends Settings {
	readonly token?: string;
}

export function configPath(root: string): string {
	return join(stateDir(root), "config.json");
}

/** The nearest folder at or above `start` that has .abso/config.json (or .avcs/config.json, from before the rename), or undefined. */
export function findRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(configPath(dir))) return dir;
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

export function readConfig(root: string, env: Readonly<Record<string, string | undefined>> = process.env): Config {
	const raw = JSON.parse(readFileSync(configPath(root), "utf8")) as Partial<Settings>;
	for (const key of ["server", "project", "agent"] as const) {
		if (typeof raw[key] !== "string" || raw[key] === "") throw new Error(`${configPath(root)} has no "${key}"`);
	}
	const token = tokenFor(raw.server!, env, root);
	return {
		server: raw.server!,
		project: raw.project!,
		agent: raw.agent!,
		...(typeof raw.follow === "string" && raw.follow !== "" ? { follow: raw.follow } : {}),
		...(raw.reader === true ? { reader: true } : {}),
		...(token ? { token } : {}),
	};
}

/** Whether the folder is a reader (#37): records nothing. Read straight from its config, for the paths that only need this. */
export function isReader(root: string): boolean {
	try {
		return (JSON.parse(readFileSync(configPath(root), "utf8")) as { reader?: unknown }).reader === true;
	} catch {
		return false;
	}
}

/**
 * The token for `server`, refusing a server it may not go to (core.ts
 * tokenGoesTo): a folder's config names its server, and anyone can write one.
 */
/** What status may say about the credential. Never the key or the token. */
export function credentialLabel(
	root: string,
	server: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): { kind: "agent key" | "shared token" | "none"; id: string | null } {
	const key = readKeyFile(root);
	if (key) {
		if (originOf(key.server) !== originOf(server)) return { kind: "none", id: null };
		return { kind: "agent key", id: key.id };
	}
	return { kind: readToken(env) ? "shared token" : "none", id: null };
}

interface StoredKey {
	server: string;
	key: string;
	id: string;
}

function keyPath(root: string): string {
	return join(stateDir(root), "key");
}

function originOf(server: string): string {
	try {
		return new URL(server).origin;
	} catch {
		return server;
	}
}

function readKeyFile(root: string): StoredKey | undefined {
	try {
		const raw = JSON.parse(readFileSync(keyPath(root), "utf8")) as Partial<StoredKey>;
		if (typeof raw.server !== "string" || typeof raw.key !== "string" || typeof raw.id !== "string") return undefined;
		if (!raw.key.startsWith("abso_sk_") || !/^k_[0-9a-f]{8}$/.test(raw.id)) return undefined;
		return { server: raw.server, key: raw.key, id: raw.id };
	} catch {
		return undefined;
	}
}

/**
 * Writes `.avcs/key` from the JSON the staging issue route printed (`{key, id}`),
 * pinned to this folder's server, or to `serverFlag` in a folder not joined yet.
 * Reads stdin. Prints nothing that contains the key.
 */
export function installKey(root: string, stdin: string, serverFlag?: string): { id: string } {
	const configured = existsSync(configPath(root))
		? (JSON.parse(readFileSync(configPath(root), "utf8")) as { server?: string }).server
		: undefined;
	if (configured && serverFlag && originOf(configured) !== originOf(serverFlag))
		throw new UsageError(`this folder's server is ${configured}, not ${serverFlag}`);
	const server = configured ?? serverFlag;
	if (!server) throw new UsageError("this folder has no .abso/config.json yet: give --server <url>");
	let parsed: { key?: unknown; id?: unknown };
	try {
		parsed = JSON.parse(stdin) as { key?: unknown; id?: unknown };
	} catch {
		throw new UsageError("abso key install reads {key, id} as JSON from stdin");
	}
	if (
		typeof parsed.key !== "string" ||
		!parsed.key.startsWith("abso_sk_") ||
		typeof parsed.id !== "string" ||
		!/^k_[0-9a-f]{8}$/.test(parsed.id)
	)
		throw new UsageError("stdin needs {key, id} from the staging issue route");
	mkdirSync(stateDir(root), { recursive: true });
	writeFileSync(keyPath(root), `${JSON.stringify({ server, key: parsed.key, id: parsed.id })}\n`, { mode: 0o600 });
	try {
		chmodSync(keyPath(root), 0o600);
	} catch {
		// Windows has no owner-only mode. The file is still under .avcs/, which abso never records.
	}
	return { id: parsed.id };
}

export function tokenFor(
	server: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
	root?: string,
): string | undefined {
	if (root) {
		const key = readKeyFile(root);
		if (key) {
			if (originOf(key.server) !== originOf(server))
				throw new UsageError("this folder's key was issued for a different server, so abso will not send it");
			return key.key;
		}
	}
	const token = readToken(env);
	const trusted = trustedServers(env);
	if (token === undefined || tokenGoesTo(server, trusted)) return token;
	throw new UsageError(
		`this folder's server is ${server}, and abso sends your token only to ${[...TOKEN_SERVERS, "this machine"].join(", ")}, and the servers ~/.abso/servers.json or AVCS_TRUSTED_SERVERS name. ` +
			`If ${server} is yours, name it in ~/.abso/servers.json or AVCS_TRUSTED_SERVERS (comma-separated); if you didn't set it, someone else wrote .abso/config.json.`,
	);
}

let machine: MachineServers | undefined;
/** This machine's servers (core.ts machineServers), from ~/.abso/servers.json (or ~/.abso/servers.json), read once. AVCS_SERVERS_FILE names another file (tests). */
export function readMachineServers(env: Readonly<Record<string, string | undefined>> = process.env): MachineServers {
	if (env.AVCS_SERVERS_FILE !== undefined) return machineServers(readOr(env.AVCS_SERVERS_FILE));
	machine ??= machineServers(readOr(homeFile(homedir(), "servers.json")));
	return machine;
}
const readOr = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

/** The servers the token may go to beyond abso's own: AVCS_TRUSTED_SERVERS, then this machine's servers.json. */
export function trustedServers(env: Readonly<Record<string, string | undefined>> = process.env): string {
	return trustedList(env.AVCS_TRUSTED_SERVERS, readMachineServers(env));
}

/** AVCS_TOKEN if set, else ~/.abso/token, else ~/.avcs/token, else none. */
export function readToken(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
	if (env.AVCS_TOKEN) return env.AVCS_TOKEN.trim();
	try {
		return readFileSync(homeFile(homedir(), "token"), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export function writeConfig(root: string, settings: Settings): void {
	mkdirSync(stateDir(root), { recursive: true });
	const { server, project, agent, follow, reader } = settings;
	writeFileSync(
		configPath(root),
		`${JSON.stringify({ server, project, agent, ...(follow ? { follow } : {}), ...(reader ? { reader: true } : {}) }, null, 2)}\n`,
	);
	excludeFromGit(root);
}

/** If the folder is a git repo, keep its state folder (.abso/, or .avcs/ in an older folder) out of it (in .git/info/exclude, so .gitignore isn't changed). */
function excludeFromGit(root: string): void {
	const git = join(root, ".git");
	if (!existsSync(join(git, "HEAD"))) return;
	const exclude = join(git, "info", "exclude");
	const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	const name = `${basename(stateDir(root))}/`;
	if (text.split(/\r?\n/).some((line) => line.trim() === name || line.trim() === `/${name}`)) return;
	mkdirSync(dirname(exclude), { recursive: true });
	writeFileSync(exclude, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}/${name}\n`);
}
