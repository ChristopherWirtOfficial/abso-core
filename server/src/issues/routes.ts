// The issues routes, apart from the Durable Object so they run under node --test with a store on node:sqlite.
// Paths are the client's: /p/:project/<read> for reads, and /p/:project/a/:agent/<op> for an agent's writes and
// its own reads (waiting, asked, drafts, news). Who may call which path was decided before a request gets here.

import { type Actor, IssuesError, type IssuesStore, who } from "./store.ts";

/** The largest request body a write takes, in bytes: far above any text a write may hold. */
export const BODY_MAX = 1024 * 1024;

export const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * One request to a project's issues. `seatError` says why a new ask's `of` isn't an agent in the project, or null
 * when it is (or when the project can't say).
 */
export async function issuesRoute(
	store: IssuesStore,
	request: Request,
	seatError?: (of: string) => Promise<string | null>,
): Promise<Response> {
	try {
		return await route(store, request, seatError);
	} catch (e) {
		if (e instanceof IssuesError) {
			const answer = json(e.status, { error: e.message });
			if (e.retryAfter !== undefined) answer.headers.set("Retry-After", String(e.retryAfter));
			return answer;
		}
		throw e;
	}
}

async function route(
	store: IssuesStore,
	request: Request,
	seatError?: (of: string) => Promise<string | null>,
): Promise<Response> {
	const url = new URL(request.url);
	const m = /^\/p\/([^/]+)(?:\/a\/([^/]+))?\/(.+)$/.exec(url.pathname);
	if (!m) return json(404, { error: "no such issues route" });
	const agent = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
	const rest = m[3]!;
	const q = url.searchParams;
	const actor: Actor | undefined = agent !== undefined ? { agent } : undefined;
	if (rest === "attachments" || rest.startsWith("attachments/"))
		return json(501, { error: "this server doesn't keep attachments" });
	// A reader sees only their own drafts.
	if (request.method === "GET" && rest === "drafts") {
		if (!actor) return json(403, { error: "drafts are an agent's: /a/:agent/drafts" });
		return json(200, { drafts: store.drafts(actor) });
	}
	if (request.method === "GET") {
		if (actor) {
			// An agent's own waiting list, which marks what it lists as seen.
			if (rest === "waiting") return json(200, { asks: store.waiting(who(actor), who(actor)) });
			// The asks an agent sent, open then the latest answered.
			if (rest === "asked") return json(200, { asks: store.asked(who(actor)) });
			// An agent's news here: answers, replies, @mentions, and changes on issues it watches, by others.
			if (rest === "news") {
				const before = q.get("before");
				return json(200, {
					news: store.newsFor(actor, [who(actor)], before === null ? undefined : Number(before) || undefined),
				});
			}
			return json(404, {
				error: "an agent's reads are waiting, asked, drafts and news; other reads have no /a/:agent/",
			});
		}
		if (rest === "issues") {
			const parent = q.get("parent");
			return json(200, {
				issues: store.list({
					...(q.get("status") ? { status: q.get("status")! } : {}),
					...(q.get("agent") ? { agent: q.get("agent")! } : {}),
					...(parent ? { parent: Number(parent) } : {}),
					// ?label=a,b (or label repeated): issues with every one of them.
					...(q.getAll("label").length > 0 ? { labels: q.getAll("label").flatMap((l) => l.split(",")) } : {}),
					open: q.get("open") === "1",
				}),
			});
		}
		if (rest === "labels") return json(200, { labels: store.labelsInUse() });
		// The change count: what a reader can cache issue reads under, cheap enough to ask every request.
		if (rest === "changes") return json(200, { changes: store.changes() });
		if (rest === "search") {
			const limit = Number(q.get("limit") ?? "20");
			return json(200, { hits: store.search((q.get("q") ?? "").slice(0, 200), Number.isInteger(limit) ? limit : 20) });
		}
		const one = /^issue\/(\d+)$/.exec(rest);
		if (one) return json(200, store.page(Number(one[1])));
		if (rest === "waiting") return json(200, { asks: store.waiting(q.get("of") ?? undefined) });
		const ask = /^ask\/(\d+)$/.exec(rest);
		if (ask) return json(200, { ask: store.askThread(Number(ask[1])) });
		if (rest === "asked") {
			const by = q.get("by");
			if (!by) return json(400, { error: "asked needs ?by=<agent>" });
			return json(200, { asks: store.asked(by) });
		}
		if (rest === "answered") {
			const of = q.get("of");
			if (!of) return json(400, { error: "answered needs ?of=<agent>" });
			return json(200, { asks: store.answered(of) });
		}
		return json(404, { error: "no such issues route" });
	}
	if (request.method !== "POST") return json(405, { error: "issues takes GET and POST" });
	if (!actor) return json(403, { error: "a write is an agent's: /p/:project/a/:agent/<op>" });
	let body: Record<string, unknown> = {};
	const raw = new TextDecoder().decode(await readCapped(request, BODY_MAX));
	if (raw.trim() !== "") {
		try {
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return json(400, { error: "the body is JSON" });
		}
		if (typeof body !== "object" || body === null || Array.isArray(body))
			return json(400, { error: "the body is a JSON object" });
	}
	// Drafts and news marks make no news, so they don't count toward the writer's limit.
	if (rest === "draft") return json(200, { ok: true, ...store.saveDraft(actor, body) });
	const deleting = /^draft\/(\d+)\/delete$/.exec(rest);
	if (deleting) {
		store.deleteDraft(actor, Number(deleting[1]));
		return json(200, { ok: true });
	}
	if (rest === "news/read") {
		const at = body.at === undefined ? Date.now() : body.at;
		if (typeof at !== "number" || !Number.isFinite(at)) return json(400, { error: "at is a time in milliseconds" });
		return json(200, { ok: true, ...store.markNewsRead(actor, at) });
	}
	const write = writeFor(store, actor, rest, body);
	if (!write) return json(404, { error: "no such issues route" });
	// An ask goes to an agent in the project.
	if (rest === "ask" && seatError && typeof body.of === "string") {
		const refused = await seatError(body.of);
		if (refused) return json(400, { error: refused });
	}
	store.checkLimit(actor);
	const done = write();
	store.wrote(actor);
	// Every write answers the change count it made, for the next read.
	return json(200, { ok: true, ...done, changes: store.changes() });
}

/**
 * The body, read a chunk at a time and refused (413) the moment it passes `max`, so a body with no
 * Content-Length, or one that lies, never puts more than `max` in memory.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > max) throw new IssuesError(`the body is ${declared} bytes; the most is ${max}`, 413);
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new IssuesError(`the body is over ${max} bytes, the most there can be`, 413);
		}
		parts.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** A write that can carry news, to run once the writer's limit allows it; undefined when no route matches. */
function writeFor(
	store: IssuesStore,
	actor: Actor,
	rest: string,
	body: Record<string, unknown>,
): (() => object) | undefined {
	if (rest === "issue") return () => store.open(actor, body);
	if (rest === "ask") return () => store.ask(actor, body);
	const on = /^issue\/(\d+)\/(comment|drop|edit|reopen|done)$/.exec(rest);
	if (on) {
		const id = Number(on[1]);
		return () => {
			if (on[2] === "comment") return store.comment(actor, id, body);
			if (on[2] === "edit") return store.edit(actor, id, body);
			if (on[2] === "reopen") return store.reopen(actor, id);
			if (on[2] === "done") {
				const version = body.version;
				if (version !== undefined && version !== null && typeof version !== "number")
					throw new IssuesError("version is a published version, 1 or more");
				return store.markDone(actor, id, typeof version === "number" ? version : null);
			}
			return store.drop(actor, id);
		};
	}
	const opening = /^draft\/(\d+)\/open$/.exec(rest);
	if (opening) return () => store.openDraft(actor, Number(opening[1]), body);
	const answer = /^answer\/(\d+)$/.exec(rest);
	if (answer) return () => store.answer(actor, Number(answer[1]), body);
	const ack = /^ack\/(\d+)$/.exec(rest);
	if (ack) return () => store.ack(actor, Number(ack[1]), body);
	const reply = /^reply\/(\d+)$/.exec(rest);
	if (reply) return () => store.reply(actor, Number(reply[1]), body);
	const withdraw = /^withdraw\/(\d+)$/.exec(rest);
	if (withdraw) return () => store.withdraw(actor, Number(withdraw[1]), body);
	return undefined;
}
