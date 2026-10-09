// abso key new, list and revoke (abso issue 116). The admin token is read at
// run time and sent only as a header. It is never an argument and never printed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import type { Config } from "./config.ts";

function originOf(server: string): string {
	try {
		return new URL(server).origin;
	} catch {
		return server;
	}
}

/** The admin token goes only to a server named in AVCS_ADMIN_SERVERS (comma-separated): none is built in. */
export function adminGoesTo(server: string, extra = ""): boolean {
	const allowed = [
		...extra
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== ""),
	];
	const origin = originOf(server);
	return allowed.some((s) => originOf(s) === origin);
}

export function adminToken(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const fromEnv = env.AVCS_ADMIN_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		const fromFile = readFileSync(join(homedir(), ".avcs", "admin-token"), "utf8").trim();
		if (fromFile) return fromFile;
	} catch {}
	throw new UsageError("abso key needs the admin token in AVCS_ADMIN_TOKEN or ~/.avcs/admin-token");
}

function scrub(text: string, secrets: readonly string[]): string {
	let out = text.replace(/abso_sk_[A-Za-z0-9_-]+/g, "[redacted]");
	for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("[redacted]");
	return out;
}

async function call(config: Config, admin: string, method: "GET" | "POST", path: string): Promise<unknown> {
	if (!adminGoesTo(config.server, process.env.AVCS_ADMIN_SERVERS))
		throw new UsageError(
			`abso key will not send the admin token to ${config.server}; AVCS_ADMIN_SERVERS names the servers it may go to`,
		);
	const secrets = [admin, config.token ?? ""].filter((s) => s.length > 0);
	let response: Response;
	try {
		response = await fetch(`${config.server.replace(/\/+$/, "")}${path}`, {
			method,
			headers: {
				...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
				"x-avcs-admin": admin,
			},
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new UsageError(scrub(err instanceof Error ? err.message : String(err), secrets));
	}
	const text = await response.text();
	if (!response.ok)
		throw new UsageError(scrub(text.slice(0, 500) || `the server answered ${response.status}`, secrets));
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new UsageError("the server's answer was not JSON");
	}
}

export interface IssuedKey {
	id: string;
	key: string;
	agent: string;
}

export async function keyNew(
	config: Config,
	admin: string,
	agent: string,
	project = config.project,
	expires?: string,
	role?: "owner" | "writer" | "reader",
): Promise<IssuedKey> {
	const query = `project=${encodeURIComponent(project)}&agent=${encodeURIComponent(agent)}${expires ? `&expires=${encodeURIComponent(expires)}` : ""}${role ? `&role=${role}` : ""}`;
	const body = (await call(config, admin, "POST", `/admin/agent-keys?${query}`)) as Partial<IssuedKey>;
	if (typeof body.id !== "string" || typeof body.key !== "string")
		throw new UsageError("the server did not return a key");
	return { id: body.id, key: body.key, agent: typeof body.agent === "string" ? body.agent : agent };
}

/** What `abso key new` may show. The key is included only with --print. */
export function issuedPublic(issued: IssuedKey, print: boolean): { id: string; agent: string; key?: string } {
	return print ? { id: issued.id, agent: issued.agent, key: issued.key } : { id: issued.id, agent: issued.agent };
}

export interface ListedKey {
	id: string;
	agent: string;
	issuedBy: string;
	at: number;
	lastUsed: number | null;
	revokedAt: number | null;
	expiresAt?: number | null;
}

export async function keyList(
	config: Config,
	admin: string,
	agent?: string,
	project = config.project,
): Promise<ListedKey[]> {
	const query = `project=${encodeURIComponent(project)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
	const body = (await call(config, admin, "GET", `/admin/agent-keys?${query}`)) as { keys?: ListedKey[] };
	return body.keys ?? [];
}

export async function keyRevoke(config: Config, admin: string, id: string, project = config.project): Promise<boolean> {
	const body = (await call(
		config,
		admin,
		"POST",
		`/admin/agent-keys/revoke?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`,
	)) as { revoked?: boolean };
	return body.revoked === true;
}

/** What `abso key list` prints. The key's value is not a field, so it cannot appear. */
export function keyListText(keys: readonly ListedKey[]): string {
	if (keys.length === 0) return "No keys.";
	return keys
		.map((k) => {
			const when = new Date(k.at).toISOString().slice(0, 16).replace("T", " ");
			const used =
				k.lastUsed === null
					? "never used"
					: `last used ${new Date(k.lastUsed).toISOString().slice(0, 16).replace("T", " ")}`;
			const until = k.expiresAt ? `, until ${new Date(k.expiresAt).toISOString().slice(0, 10)}` : "";
			const state = k.revokedAt === null ? used : "revoked";
			return `${k.id}  ${k.agent}  ${k.issuedBy}  ${when}  ${state}${until}`;
		})
		.join("\n");
}
