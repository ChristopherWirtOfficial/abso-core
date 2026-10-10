// Signing in once per box (abso issue 108). `abso login` asks the server for a
// code, a person approves it on the website, and the box gets a credential
// with a grant: projects, a role cap, an agent limit and an expiry. Agents on
// the box then mint their own keys from it at `abso join`.
//
// The box credential lives in the user's config folder, one file per server,
// never in a project folder. It is never printed, never an argument, and only
// ever sent to the server that issued it: on /box/ routes, and on the org reads,
// which answer as the person who approved the box.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./args.ts";
import { homeFile, homeWritePath, OLD_STATE_DIR, STATE_DIR } from "./state-dir.ts";

/** What the person who approved the code allowed: each project with the highest role its agents get there, and how many agents. */
export interface Grant {
	readonly projects: readonly { readonly project: string; readonly role: string }[];
	readonly max_agents: number;
}

export interface BoxRecord {
	readonly server: string;
	readonly id: string;
	readonly credential: string;
	readonly grant: Grant;
	readonly expiresAt: number;
}

export function originOf(server: string): string {
	try {
		return new URL(server).origin;
	} catch {
		return server;
	}
}

function boxFile(server: string): string {
	return `${createHash("sha256").update(originOf(server)).digest("hex").slice(0, 16)}.json`;
}

export function readBox(server: string, home = homedir()): BoxRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(homeFile(home, "boxes", boxFile(server)), "utf8")) as Partial<BoxRecord>;
		if (
			typeof raw.server !== "string" ||
			originOf(raw.server) !== originOf(server) ||
			typeof raw.credential !== "string" ||
			typeof raw.id !== "string" ||
			typeof raw.expiresAt !== "number" ||
			!isGrant(raw.grant)
		)
			return undefined;
		return raw as BoxRecord;
	} catch {
		return undefined;
	}
}

/** The servers this box is signed in to and whose sign-in hasn't expired, from ~/.abso/boxes (and an older ~/.avcs/boxes). */
export function signedInServers(home = homedir(), now = Date.now()): string[] {
	const servers = new Set<string>();
	for (const dir of [STATE_DIR, OLD_STATE_DIR]) {
		let names: string[];
		try {
			names = readdirSync(join(home, dir, "boxes"));
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const server = (JSON.parse(readFileSync(join(home, dir, "boxes", name), "utf8")) as { server?: unknown })
					.server;
				if (typeof server !== "string") continue;
				const record = readBox(server, home);
				if (record && record.expiresAt > now) servers.add(originOf(record.server));
			} catch {
				// Not a sign-in this client wrote: left alone.
			}
		}
	}
	return [...servers].sort();
}

export function writeBox(record: BoxRecord, home = homedir()): void {
	const path = homeWritePath(home, "boxes", boxFile(record.server));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows has no owner-only mode; the file is still outside every project folder.
	}
}

/** Logout ends the sign-in everywhere on this machine: the credential under ~/.abso and any older copy under ~/.avcs. */
export function forgetBox(server: string, home = homedir()): boolean {
	const paths = [homeWritePath(home, "boxes", boxFile(server)), join(home, OLD_STATE_DIR, "boxes", boxFile(server))];
	const had = paths.filter((path) => existsSync(path));
	for (const path of had) rmSync(path, { force: true });
	return had.length > 0;
}

/** Error text with the credential (and anything shaped like a key) taken out. */
function scrub(text: string, secrets: readonly string[]): string {
	let out = text.replace(/abso_(sk|bx)_[A-Za-z0-9_-]+/g, "[redacted]");
	for (const s of secrets) if (s.length > 0) out = out.split(s).join("[redacted]");
	return out;
}

export interface Answer {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

async function call(
	server: string,
	path: string,
	body: unknown,
	credential: string | undefined,
	fetcher: typeof fetch,
): Promise<Answer> {
	const secrets = credential ? [credential] : [];
	let response: Response;
	try {
		response = await fetcher(`${originOf(server)}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(credential ? { authorization: `Box ${credential}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new UsageError(
			`couldn't reach ${originOf(server)}: ${scrub(err instanceof Error ? err.message : String(err), secrets)}`,
		);
	}
	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		if (response.ok) throw new UsageError(`${originOf(server)}${path} didn't answer JSON`);
	}
	if (!response.ok && !(response.status === 400 && path === "/login/token")) {
		const said = typeof parsed.error === "string" ? parsed.error : text.slice(0, 300);
		throw new UsageError(scrub(`${originOf(server)} refused (${response.status}): ${said}`, secrets));
	}
	return { status: response.status, body: parsed };
}

/**
 * A read that answers as the person who approved this box: the org reads (GET /orgs, /orgs/<name>). Answers the
 * status and body as they came, refusals included, so the caller can say what each means; never the credential.
 */
export async function boxGet(record: BoxRecord, path: string, fetcher: typeof fetch = fetch): Promise<Answer> {
	const secrets = [record.credential];
	let response: Response;
	try {
		response = await fetcher(`${originOf(record.server)}${path}`, {
			headers: { authorization: `Box ${record.credential}` },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new UsageError(
			`couldn't reach ${originOf(record.server)}: ${scrub(err instanceof Error ? err.message : String(err), secrets)}`,
		);
	}
	const text = await response.text();
	try {
		const body = JSON.parse(text) as unknown;
		if (typeof body === "object" && body !== null && !Array.isArray(body))
			return { status: response.status, body: body as Record<string, unknown> };
	} catch {}
	return { status: response.status, body: { error: scrub(text.slice(0, 300), secrets) } };
}

/** This machine's name, as the server takes a box's name: 1-64 letters, digits, '.', '_' or '-'. */
function boxName(): string {
	const name = hostname()
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.slice(0, 64);
	return name || "box";
}

function isGrant(g: unknown): g is Grant {
	const x = g as Partial<Grant> | null;
	return (
		typeof x === "object" &&
		x !== null &&
		Array.isArray(x.projects) &&
		x.projects.every((p) => typeof p?.project === "string" && typeof p.role === "string") &&
		typeof x.max_agents === "number"
	);
}

/** The longest login waits for approval, whatever the server says. */
const MAX_LOGIN_WAIT_S = 30 * 60;
/** How often login says it's still waiting. */
const STILL_WAITING_MS = 60_000;

export interface LoginIo {
	readonly fetch?: typeof fetch;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	/** Where the code and link go while login waits: stderr, so stdout stays quiet. */
	readonly say: (line: string) => void;
	/** Opens the approve page in a browser, answering whether it tried. None where it shouldn't (--no-browser, SSH, CI). */
	readonly open?: (url: string) => boolean;
}

/**
 * Asks `server` for a code, shows it with its link, and waits for a person to
 * approve it. Answers the box's record, already written to the config folder.
 */
export async function login(server: string, io: LoginIo, home = homedir()): Promise<BoxRecord> {
	const fetcher = io.fetch ?? fetch;
	const sleep = io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	const now = io.now ?? Date.now;
	const start = await call(server, "/login/device", { name: boxName(), client: "abso" }, undefined, fetcher);
	const { device_code: device, user_code: code, verification_uri_complete: link } = start.body;
	let interval = Number(start.body.interval) || 5;
	// The server says when its code runs out; a server that says never still gets an end.
	const expiresIn = Math.min(Number(start.body.expires_in) || 900, MAX_LOGIN_WAIT_S);
	if (typeof code !== "string" || typeof link !== "string" || typeof device !== "string")
		throw new UsageError(`${originOf(server)} didn't give a code to approve`);
	// The page opens with the code in it, so nobody copies a link by hand. The link and code are printed all the same.
	if (io.open?.(link)) io.say("Opening the approve page in your browser.");
	io.say(`To sign this box in, open ${link} and approve the code ${code}.`);
	io.say("Waiting for approval. Ctrl-C stops waiting, and abso stops by itself when the code runs out.");
	const until = now() + expiresIn * 1000;
	let toldAt = now();
	while (now() < until) {
		await sleep(interval * 1000);
		// A wait with no word looks like a hang, so say it's still waiting now and then.
		if (now() - toldAt >= STILL_WAITING_MS) {
			io.say(`Still waiting for the code ${code} to be approved.`);
			toldAt = now();
		}
		const a = await call(server, "/login/token", { device_code: device }, undefined, fetcher);
		if (a.status === 400) {
			if (a.body.error === "authorization_pending") continue;
			if (a.body.error === "slow_down") {
				interval += 5;
				continue;
			}
			if (a.body.error === "access_denied") throw new UsageError(`the code ${code} was turned down.`);
			throw new UsageError(`the code ${code} ran out. Run abso login again.`);
		}
		const { box_token: credential, box_id: id, grant, expires_at } = a.body;
		const expiresAt = typeof expires_at === "string" ? Date.parse(expires_at) : Number.NaN;
		if (typeof credential !== "string" || typeof id !== "string" || !isGrant(grant) || Number.isNaN(expiresAt))
			throw new UsageError(`${originOf(server)} approved the code but sent no credential`);
		const record: BoxRecord = { server: originOf(server), id, credential, grant, expiresAt };
		writeBox(record, home);
		return record;
	}
	throw new UsageError(`nobody approved the code ${code} in time. Run abso login again.`);
}

/** An agent's own key, minted from the box's credential: `{key, id}`, as `abso key install` takes it. */
export async function mintKey(
	record: BoxRecord,
	project: string,
	agent: string,
	fetcher: typeof fetch = fetch,
): Promise<{ key: string; id: string }> {
	const a = await call(record.server, "/box/agent-key", { project, agent }, record.credential, fetcher);
	const { key, id } = a.body;
	if (typeof key !== "string" || typeof id !== "string")
		throw new UsageError(`${record.server} didn't send a key for ${agent}`);
	return { key, id };
}

/** The agent name abso join takes when none is given: the box's name, lower-cased. */
export function defaultAgentName(): string {
	return boxName().toLowerCase();
}

/**
 * abso join with no --agent: mints a key under `base`, else `base`-2, -3 and so on. Names this
 * box already holds in the project are skipped without asking, since minting one again would replace that agent's
 * key and cut off its folder. A name the server says is taken (409) moves on to the next; any other refusal, the
 * box's agent limit among them, is said as it is.
 */
export async function mintFreeName(
	record: BoxRecord,
	project: string,
	base: string,
	fetcher: typeof fetch = fetch,
	tries = 20,
): Promise<{ key: string; id: string; agent: string }> {
	const box = await boxGet(record, "/box", fetcher);
	if (box.status !== 200)
		throw new UsageError(
			`${originOf(record.server)} refused (${box.status}): ${String(box.body.error ?? "no reason given")}`,
		);
	const agents = Array.isArray(box.body.agents) ? (box.body.agents as { project?: unknown; agent?: unknown }[]) : [];
	const held = new Set(agents.filter((a) => a.project === project).map((a) => String(a.agent)));
	for (let n = 1; n <= tries; n++) {
		const agent = n === 1 ? base : `${base}-${n}`;
		if (held.has(agent)) continue;
		try {
			return { ...(await mintKey(record, project, agent, fetcher)), agent };
		} catch (err) {
			if (err instanceof UsageError && /refused \(409\): that agent name/.test(err.message)) continue;
			if (err instanceof UsageError && /refused \(409\): this box is at its agent limit/.test(err.message))
				throw new UsageError(
					`this box is at its agent limit (${record.grant.max_agents}): abso box shows its grant, and an agent can be revoked on the website's Boxes page`,
				);
			throw err;
		}
	}
	throw new UsageError(
		`${base} through ${base}-${tries} are all taken in ${project}: give this agent a name with --agent <name>`,
	);
}

/** Ends the box on the server, then forgets it here. Forgets it even when the server can't be reached. */
export async function logout(record: BoxRecord, fetcher: typeof fetch = fetch, home = homedir()): Promise<boolean> {
	let ended = true;
	try {
		await call(record.server, "/box/logout", {}, record.credential, fetcher);
	} catch {
		ended = false;
	}
	forgetBox(record.server, home);
	return ended;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** What `abso box` prints: the grant, never the credential. */
export function boxText(record: BoxRecord | undefined, server: string, now = Date.now()): string {
	if (!record) return `This box isn't signed in to ${originOf(server)}. abso login signs it in.`;
	const g = record.grant;
	const expired = record.expiresAt <= now;
	return [
		`Signed in to ${record.server} as box ${record.id}${expired ? ", but the sign-in has expired. abso login renews it." : "."}`,
		`Projects: ${g.projects.map((p) => `${p.project} (${p.role})`).join(", ")}. Up to ${g.max_agents} agents.`,
		`${expired ? "Expired" : "Expires"} ${day(record.expiresAt)} UTC.`,
	].join("\n");
}

/** What `abso box --json` answers: the record without its credential. */
export function boxPublic(
	record: BoxRecord | undefined,
): { server: string; id: string; grant: Grant; expiresAt: string } | null {
	return record
		? { server: record.server, id: record.id, grant: record.grant, expiresAt: new Date(record.expiresAt).toISOString() }
		: null;
}
