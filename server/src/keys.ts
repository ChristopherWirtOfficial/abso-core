// Per-agent keys, ported from the platform's worker/src/keys.ts. They run when AGENT_KEYS is "on" and
// KEY_HMAC_SECRET is set. Each key belongs to one agent of one project; the project's Durable Object keeps only the
// key's HMAC, never the key. Without keys, the shared token (ABSO_TOKEN) is the only way in.

export const KEY_PREFIX = "abso_sk_";
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUDIT_CAP = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface KeyEnv {
	AGENT_KEYS?: string;
	KEY_HMAC_SECRET?: string;
}

/** What a key may do in its project: the admin's choice when it was issued. */
export type KeyRole = "owner" | "writer" | "reader";

export interface KeyRow {
	id: string;
	hmac: string;
	agent: string;
	issuedBy: string;
	at: number;
	lastUsed: number | null;
	revokedAt: number | null;
	expiresAt?: number | null;
	/** Absent on a key issued before roles existed: it counts as reader, so it fails closed. */
	role?: KeyRole;
}

export interface FailRow {
	n: number;
	at: number;
}

export interface AuditRow {
	t: number;
	kind: "issue" | "revoke" | "use" | "fail";
	id: string | null;
	addr: string;
}

export interface KeyState {
	rows: KeyRow[];
	fails: Record<string, FailRow>;
	seen: Record<string, string>;
	audit: AuditRow[];
}

export function emptyKeyState(): KeyState {
	return { rows: [], fails: {}, seen: {}, audit: [] };
}

/** Keys run when the switch and the secret are both set. */
export function keysEnabled(env: KeyEnv): boolean {
	return env.AGENT_KEYS === "on" && !!env.KEY_HMAC_SECRET;
}

/** 90 days when omitted. 1d to 365d otherwise. */
export function expiresAt(now: number, raw: string | null): number | { error: string } {
	if (raw === null || raw === "") return now + 90 * DAY_MS;
	const match = /^(\d+)d$/.exec(raw);
	if (!match) return { error: "expires is a number of days, like 7d, from 1d to 365d" };
	const days = Number(match[1]);
	if (days < 1 || days > 365) return { error: "expires is from 1d to 365d" };
	return now + days * DAY_MS;
}

export function isAgentKey(presented: string | undefined): boolean {
	return typeof presented === "string" && presented.startsWith(KEY_PREFIX) && presented.length > KEY_PREFIX.length;
}

export async function hmac(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether two strings are equal, taking the same time wherever they differ. */
export function timingSame(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function randomHex(bytes: number): string {
	const b = new Uint8Array(bytes);
	crypto.getRandomValues(b);
	return [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export function newKey(): { id: string; key: string } {
	const raw = new Uint8Array(32);
	crypto.getRandomValues(raw);
	const body = btoa(String.fromCharCode(...raw))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	return { id: `k_${randomHex(4)}`, key: `${KEY_PREFIX}${body}` };
}

function note(state: KeyState, row: AuditRow): void {
	state.audit.push(row);
	if (state.audit.length > AUDIT_CAP) state.audit.splice(0, state.audit.length - AUDIT_CAP);
}

export interface Issued {
	id: string;
	key: string;
	agent: string;
}

/** Issues a key. The returned value is the only copy; the state keeps the HMAC. */
export async function issueKey(
	state: KeyState,
	secret: string,
	agent: string,
	by: string,
	now: number,
	address: string,
	expires: number,
	role: KeyRole,
): Promise<Issued> {
	const made = newKey();
	const addr = await hmac(secret, address);
	state.rows.push({
		id: made.id,
		hmac: await hmac(secret, made.key),
		agent,
		issuedBy: by,
		at: now,
		lastUsed: null,
		revokedAt: null,
		expiresAt: expires,
		role,
	});
	note(state, { t: now, kind: "issue", id: made.id, addr });
	return { id: made.id, key: made.key, agent };
}

export function revokeKey(state: KeyState, id: string, now: number, addr: string): boolean {
	const row = state.rows.find((r) => r.id === id);
	if (!row || row.revokedAt !== null) return false;
	row.revokedAt = now;
	note(state, { t: now, kind: "revoke", id, addr });
	return true;
}

export function listKeys(state: KeyState, agent?: string) {
	return state.rows
		.filter((r) => agent === undefined || r.agent === agent)
		.map(({ id, agent: a, issuedBy, at, lastUsed, revokedAt, expiresAt: exp, role }) => ({
			id,
			agent: a,
			role: role ?? "reader",
			issuedBy,
			at,
			lastUsed,
			revokedAt,
			expiresAt: exp ?? null,
		}));
}

export type KeyDecision =
	| { ok: true; id: string; as: string; role: KeyRole; dirty: boolean }
	| { ok: false; status: number; error: string; dirty: boolean };

/**
 * Checks a presented key against one project. The URL's agent must match the key's agent: a mismatch is a 403, and
 * the agent is not rewritten. A missing secret is a 503 that names no key. Failures are counted per address and
 * slowed after a few. Nothing returned or recorded contains the key.
 */
export async function checkKey(
	state: KeyState,
	secret: string | undefined,
	presented: string,
	agent: string | undefined,
	now: number,
	address: string,
): Promise<KeyDecision> {
	if (!secret) return { ok: false, status: 503, error: "the key secret (KEY_HMAC_SECRET) is not set", dirty: false };
	const addr = await hmac(secret, address);
	const fail = state.fails[addr];
	if (fail && now - fail.at < FAIL_WINDOW_MS && fail.n >= FAIL_LIMIT) {
		return { ok: false, status: 429, error: "too many failed keys; try again shortly", dirty: false };
	}
	const mac = await hmac(secret, presented);
	const row = state.rows.find((r) => timingSame(r.hmac, mac));
	const bump = () => {
		const cur = state.fails[addr];
		state.fails[addr] = !cur || now - cur.at >= FAIL_WINDOW_MS ? { n: 1, at: now } : { n: cur.n + 1, at: cur.at };
		note(state, { t: now, kind: "fail", id: row?.id ?? null, addr });
	};
	if (!row || row.revokedAt !== null || (row.expiresAt != null && now >= row.expiresAt)) {
		bump();
		const error = !row
			? "that key is not for this project"
			: row.revokedAt !== null
				? "that key was revoked"
				: "that key has expired";
		return { ok: false, status: 403, error, dirty: true };
	}
	if (agent !== undefined && row.agent !== agent) {
		bump();
		return { ok: false, status: 403, error: "that key is not for this agent", dirty: true };
	}
	let dirty = false;
	if (state.fails[addr]) {
		delete state.fails[addr];
		dirty = true;
	}
	if (state.seen[row.id] !== addr) {
		state.seen[row.id] = addr;
		note(state, { t: now, kind: "use", id: row.id, addr });
		dirty = true;
	}
	if (row.lastUsed === null || now - row.lastUsed >= 60_000) {
		row.lastUsed = now;
		dirty = true;
	}
	return { ok: true, id: row.id, as: `key ${row.id}`, role: row.role ?? "reader", dirty };
}

/** Project routes only an owner's key may use, whatever the method. */
const OWNER_ONLY = new Set(["git-remote", "git-sync", "export"]);

/**
 * Whether a key's role allows a request. A reader only reads. A writer also writes, but only on its own agent's
 * routes (/a/:agent/..., where checkKey has matched the agent), and blob uploads, which a record needs. Owner-only
 * routes need an owner's key.
 */
export function keyAllows(
	role: KeyRole,
	request: { write: boolean; agent: string | undefined; route: string | undefined; method?: string },
): { ok: true } | { ok: false; status: number; error: string } {
	if (role === "owner") return { ok: true };
	if (request.route !== undefined && OWNER_ONLY.has(request.route))
		return { ok: false, status: 403, error: `${request.route} needs an owner's key` };
	if (!request.write) return { ok: true };
	if (role === "reader") return { ok: false, status: 403, error: "this key only reads" };
	if (request.method === "PUT" && /^blobs\/[0-9a-f]{64}$/.test(request.route ?? "")) return { ok: true };
	if (request.agent === undefined)
		return { ok: false, status: 403, error: "a writer's key writes only on its own agent's routes" };
	return { ok: true };
}
