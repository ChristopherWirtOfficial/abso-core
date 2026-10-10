// abso whoami and abso doctor: who and where this box and folder are signed in, and a check of each thing
// a command needs (Node, the server, the box's sign-in, the folder's key), one line each, with the next step
// when one fails. Neither prints a credential. plainError words the commonest failures the same way.

import { ApiError } from "./api-error.ts";
import { type Answer, type BoxRecord, boxGet, boxText, originOf, readBox } from "./box.ts";
import { builtCopy } from "./client-version.ts";
import { type Config, credentialLabel, findRoot, readConfig } from "./config.ts";

/** The lowest Node major each kind of copy runs on: the npm package is built for 20, a checkout runs its .ts as is. */
export function nodeNeeded(built: boolean): number {
	return built ? 20 : 24;
}

/** What whoami and doctor read from outside: the network, the clock, Node's version and the home folder. Tests give their own. */
export interface Probe {
	readonly fetcher: typeof fetch;
	readonly now: number;
	readonly node: string;
	readonly built: boolean;
	readonly home?: string;
}

export function realProbe(): Probe {
	return { fetcher: fetch, now: Date.now(), node: process.versions.node, built: builtCopy() };
}

/** This folder's settings, or why they can't be read; undefined outside a folder. */
function folderOf(
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): { root: string; config?: Config; problem?: string } | undefined {
	const root = findRoot(cwd);
	if (root === undefined) return undefined;
	try {
		return { root, config: readConfig(root, env) };
	} catch (err) {
		return { root, problem: err instanceof Error ? err.message : String(err) };
	}
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** The server's view of this box: GET /box, as the box. */
async function serverBox(record: BoxRecord, probe: Probe): Promise<Answer | { unreachable: string }> {
	try {
		return await boxGet(record, "/box", timed(probe.fetcher, 10_000));
	} catch (err) {
		return { unreachable: err instanceof Error ? err.message : String(err) };
	}
}

/** fetch with its own, shorter limit: a check that hangs says so rather than waiting out the command's. */
function timed(fetcher: typeof fetch, ms: number): typeof fetch {
	return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
		fetcher(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

function credentialWords(root: string, server: string, env: Readonly<Record<string, string | undefined>>): string {
	const c = credentialLabel(root, server, env);
	return c.kind === "agent key" ? `the agent key ${c.id}` : c.kind === "shared token" ? "the shared token" : "no key";
}

export async function whoami(
	server: string,
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
	probe: Probe,
): Promise<{ text: string; json: Record<string, unknown> }> {
	const lines: string[] = [];
	const record = readBox(server, probe.home);
	let box: Record<string, unknown> | null = null;
	if (!record) {
		lines.push(`This box isn't signed in to ${originOf(server)}. Run abso login.`);
	} else {
		const answer = await serverBox(record, probe);
		const [first, ...rest] = boxText(record, server, probe.now).split("\n");
		box = {
			server: record.server,
			id: record.id,
			grant: record.grant,
			expiresAt: new Date(record.expiresAt).toISOString(),
		};
		if ("unreachable" in answer) {
			lines.push(first!, ...rest, `${originOf(server)} couldn't be reached to confirm it: ${answer.unreachable}`);
			box.confirmed = null;
		} else if (answer.status === 200 && answer.body.revoked_at == null) {
			const by = typeof answer.body.approved_by === "string" ? `, approved by ${answer.body.approved_by}` : "";
			lines.push(`${first!.replace(/\.$/, "")}${by}.`, ...rest);
			box.confirmed = true;
			if (by) box.approvedBy = answer.body.approved_by;
		} else {
			lines.push(`${originOf(server)} no longer accepts this box's sign-in (signed out or revoked). Run abso login.`);
			box.confirmed = false;
		}
	}
	const folder = folderOf(cwd, env);
	let here: Record<string, unknown> | null = null;
	if (folder?.config) {
		const c = folder.config;
		const credential = credentialWords(folder.root, c.server, env);
		lines.push(
			`This folder is agent ${c.agent} in project ${c.project} on ${originOf(c.server)}, with ${credential}${c.reader ? ", as a reader" : ""}.`,
		);
		here = { root: folder.root, project: c.project, agent: c.agent, server: c.server, credential };
	} else if (folder) {
		lines.push(`This folder's settings can't be read: ${folder.problem}`);
		here = { root: folder.root, problem: folder.problem };
	} else {
		lines.push("You're not in an abso folder. abso join <project> makes one.");
	}
	return { text: lines.join("\n"), json: { server: originOf(server), box, folder: here } };
}

export interface Check {
	readonly check: "node" | "server" | "box" | "folder";
	/** ok passes, fail needs the next step it gives, skip doesn't apply here. */
	readonly result: "ok" | "fail" | "skip";
	readonly text: string;
}

export async function doctor(
	server: string,
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
	probe: Probe,
): Promise<Check[]> {
	const checks: Check[] = [];
	const need = nodeNeeded(probe.built);
	const major = Number(probe.node.split(".")[0]);
	checks.push(
		major >= need
			? { check: "node", result: "ok", text: `Node ${probe.node} (abso needs ${need} or later).` }
			: {
					check: "node",
					result: "fail",
					text: `Node ${probe.node} is too old: abso needs ${need} or later. Install a newer Node from nodejs.org.`,
				},
	);

	const folder = folderOf(cwd, env);
	// The folder's own server when there is one: it's the one its commands talk to.
	const target = folder?.config?.server ?? server;
	const origin = originOf(target);
	let reachable = false;
	const started = Date.now();
	try {
		const res = await timed(probe.fetcher, 10_000)(`${origin}/version`);
		const body = (await res.json().catch(() => ({}))) as { commit?: unknown };
		reachable = res.ok;
		checks.push(
			res.ok
				? {
						check: "server",
						result: "ok",
						text: `${origin} answers${typeof body.commit === "string" ? ` (version ${body.commit.slice(0, 7)})` : ""} in ${Date.now() - started} ms.`,
					}
				: {
						check: "server",
						result: "fail",
						text: `${origin} answered ${res.status}. It may be down for a moment: try again shortly.`,
					},
		);
	} catch (err) {
		const why = err instanceof Error && err.name === "TimeoutError" ? "no answer within 10 s" : plainCause(err);
		checks.push({
			check: "server",
			result: "fail",
			text: `Can't reach ${origin}: ${why}. Check your connection${folder?.config ? ", and the server in .abso/config.json" : ""}.`,
		});
	}

	const record = readBox(target, probe.home);
	if (!record) {
		checks.push({
			check: "box",
			result: folder?.config ? "skip" : "fail",
			text: `This box isn't signed in to ${origin}. ${folder?.config ? "Only abso join needs it; abso login signs it in." : "Run abso login."}`,
		});
	} else if (record.expiresAt <= probe.now) {
		checks.push({
			check: "box",
			result: "fail",
			text: `This box's sign-in expired ${day(record.expiresAt)} UTC. Run abso login.`,
		});
	} else if (!reachable) {
		checks.push({
			check: "box",
			result: "skip",
			text: `Signed in as box ${record.id}; the server can't confirm it now.`,
		});
	} else {
		const answer = await serverBox(record, probe);
		checks.push(
			"unreachable" in answer
				? { check: "box", result: "skip", text: `Signed in as box ${record.id}; the server can't confirm it now.` }
				: answer.status === 200 && answer.body.revoked_at == null
					? {
							check: "box",
							result: "ok",
							text: `Signed in as box ${record.id}, which ${origin} accepts, until ${day(record.expiresAt)} UTC.`,
						}
					: {
							check: "box",
							result: "fail",
							text: `${origin} no longer accepts this box's sign-in (signed out or revoked). Run abso login.`,
						},
		);
	}

	if (!folder) {
		checks.push({
			check: "folder",
			result: "skip",
			text: "You're not in an abso folder. abso join <project> makes one.",
		});
	} else if (!folder.config) {
		checks.push({ check: "folder", result: "fail", text: `This folder's settings can't be read: ${folder.problem}` });
	} else {
		checks.push(await folderCheck(folder.root, folder.config, env, reachable, probe));
	}
	return checks;
}

/** The folder's key against its project: GET head, which the server answers only after it has checked the key. */
async function folderCheck(
	root: string,
	c: Config,
	env: Readonly<Record<string, string | undefined>>,
	reachable: boolean,
	probe: Probe,
): Promise<Check> {
	const who = `agent ${c.agent} in ${c.project}`;
	if (!c.token)
		return {
			check: "folder",
			result: "fail",
			text: `This folder (${who}) has no key, and there's no shared token. Run abso login, then abso join ${c.project}.`,
		};
	const credential = credentialWords(root, c.server, env);
	if (!reachable)
		return {
			check: "folder",
			result: "skip",
			text: `This folder is ${who}, with ${credential}; the server can't check it now.`,
		};
	let status: number;
	try {
		const res = await timed(probe.fetcher, 10_000)(
			`${c.server.replace(/\/+$/, "")}/p/${encodeURIComponent(c.project)}/head`,
			{ headers: { authorization: `Bearer ${c.token}` } },
		);
		status = res.status;
		await res.body?.cancel();
	} catch {
		return {
			check: "folder",
			result: "skip",
			text: `This folder is ${who}, with ${credential}; the server can't check it now.`,
		};
	}
	if (status === 200)
		return {
			check: "folder",
			result: "ok",
			text: `This folder is ${who}, with ${credential}, which the server accepts.`,
		};
	if (status === 404)
		return {
			check: "folder",
			result: "fail",
			text: `${originOf(c.server)} has no project ${c.project}. Check the name in .abso/config.json, or abso init makes it.`,
		};
	if (status === 401 || status === 403)
		return {
			check: "folder",
			result: "fail",
			text: `${originOf(c.server)} didn't accept ${credential} for ${c.project}: it may be revoked or expired. Ask the project's owner, or run abso join ${c.project} again from a signed-in box.`,
		};
	return {
		check: "folder",
		result: "fail",
		text: `${originOf(c.server)} answered ${status} for ${c.project}. Try again shortly.`,
	};
}

export function doctorText(checks: readonly Check[]): string {
	return checks.map((c) => `${c.result.padEnd(4)}  ${c.text}`).join("\n");
}

function plainCause(err: unknown): string {
	const cause = (err as { cause?: { code?: string; message?: string } }).cause;
	if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") return "the address doesn't resolve";
	if (cause?.code === "ECONNREFUSED") return "the connection was refused";
	return cause?.message ?? (err instanceof Error ? err.message : String(err));
}

/**
 * The commonest failures in plain words, with the next step: no credential, a credential the server refuses, and a
 * server that can't be reached. Anything else is left as it was. `signedIn` is whether the call carried a key or token.
 */
export function plainError(err: unknown, signedIn: boolean): string | undefined {
	if (!(err instanceof ApiError)) return undefined;
	if (err.status === 401)
		return signedIn
			? `The server didn't accept this folder's key: it may be revoked or expired. abso doctor checks it. (${err.message})`
			: "You're not signed in. Run abso login, then abso join <project>.";
	if (err.status === undefined && err.message.startsWith("could not reach ")) {
		const said = err.message.replace(/^could not reach /, "Can't reach ");
		// A message that already gives its next step (publish's "Run the same command again.") keeps it as the last word.
		return /\bRun\b[^.]*\.$/.test(said)
			? said
			: `${said.replace(/\.$/, "")}. Check your connection; abso doctor checks the rest.`;
	}
	return undefined;
}
