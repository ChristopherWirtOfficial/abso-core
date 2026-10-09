// avcs-view: what abso knows about this chat's folder, at a glance (#12).
//
// A status line entry, kept current: the space the folder is in, how many
// files the draft changes, how far shared has moved on, who else has
// unpublished changes in the same files, and news not yet looked at.
// `/avcs-view` opens a pane with the whole picture.
//
// Outside an abso folder it costs one folder lookup at session start and
// nothing after. Inside one, it asks the server for /status and /where at
// most every 30 seconds, and a few seconds after an edit.

import type { Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { AvcsView } from "../types";
import { STAMP } from "./stamp.ts";

const PANE = "avcs-view";
const COMMAND = "avcs-view";
const TICK_MS = 3_000;
const REFRESH_MS = 30_000;
const AFTER_EDIT_MS = 2_000;
const NEWS_SHOWN = 12;
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
/** Sent with each call, so the server can tell which mod, from which commit, made it (#29). */
const CLIENT = `avcs-view/${STAMP ?? "checkout"}`;

const view = atom({ plugin: "avcs-view", key: "view" } as const, null);
const seenNewsAt = atom({ plugin: "avcs-view", key: "seenNewsAt" } as const, "");

// The engine interface, passed along (the validator refuses keeping it).
type Engine = any;

type Folder = { root: string; server: string; project: string; agent: string };

let folder: Folder | undefined;
let lastRefresh = 0;
let editedAt = 0;
let refreshing = false;

function slash(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function readOr($: Engine, path: string): Promise<string | undefined> {
	try {
		return await $.fs.read(path);
	} catch {
		return undefined;
	}
}

/** The abso folder at or above `dir`, with its settings. */
async function findFolder($: Engine, dir: string): Promise<Folder | undefined> {
	for (let at = slash(dir); at !== ""; ) {
		const raw = await readOr($, `${at}/.avcs/config.json`);
		if (raw !== undefined) {
			try {
				const c = JSON.parse(raw) as { server: string; project: string; agent: string };
				return { root: at, server: c.server, project: c.project, agent: c.agent };
			} catch {
				return undefined;
			}
		}
		const up = at.slice(0, at.lastIndexOf("/"));
		if (up === at || up === "" || /^[A-Za-z]:$/.test(up)) break;
		at = up;
	}
	return undefined;
}

/**
 * The servers the token goes to: the same rule as the client's core.ts tokenGoesTo (#30), copied because this
 * mod installs alone. abso's hosted server and its Issues Worker, then this machine's ~/.avcs/servers.json and AVCS_TRUSTED_SERVERS.
 */
const TOKEN_SERVERS = ["https://api.abso.dev", "https://issues.abso.dev"];

/** The servers ~/.avcs/servers.json names, and their Issues Workers: core.ts machineServers, copied. */
function machineTrusted(text: string | undefined): string[] {
	const out: string[] = [];
	try {
		const servers = (JSON.parse(text ?? "{}") as { servers?: unknown }).servers;
		if (servers && typeof servers === "object")
			for (const [server, about] of Object.entries(servers as Record<string, unknown>)) {
				out.push(server);
				const i = (about as { issues?: unknown } | null)?.issues;
				if (typeof i === "string") out.push(i);
			}
	} catch {}
	return out;
}

function tokenGoesTo(server: string, trusted: string | undefined): boolean {
	const origin = (s: string): string | undefined => {
		const m = /^(https?):\/\/([^/?#\\]+)\/*$/i.exec(s.trim());
		if (!m || m[2]!.includes("@")) return undefined;
		return `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}`;
	};
	const o = origin(server);
	if (o === undefined) return false;
	const host = o.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
	if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
	return [...TOKEN_SERVERS, ...(trusted ?? "").split(",")].some((t) => t.trim() !== "" && origin(t) === o);
}

async function token($: Engine, server: string): Promise<string | undefined> {
	const home = (await $.env.get("USERPROFILE")) ?? (await $.env.get("HOME"));
	const machine = home ? machineTrusted(await readOr($, `${slash(home)}/.avcs/servers.json`)) : [];
	const trusted = [(await $.env.get("AVCS_TRUSTED_SERVERS")) ?? "", ...machine].join(",");
	if (!tokenGoesTo(server, trusted)) return undefined;
	const env = await $.env.get("AVCS_TOKEN");
	if (env) return env.trim();
	return home ? (await readOr($, `${slash(home)}/.avcs/token`))?.trim() || undefined : undefined;
}

async function get($: Engine, f: Folder, path: string): Promise<any> {
	const bearer = await token($, f.server);
	const r = await $.http.fetch(`${f.server.replace(/\/+$/, "")}/p/${encodeURIComponent(f.project)}${path}`, {
		headers: { "x-avcs-client": CLIENT, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
	});
	if (!r.ok) throw new Error(`${path} answered ${r.status}`);
	return JSON.parse(r.text);
}

/** The last news lines from .avcs/news.log, oldest first. */
async function newsOf($: Engine, root: string): Promise<[string, string][]> {
	const text = (await readOr($, `${root}/.avcs/news.log`)) ?? "";
	return text
		.split("\n")
		.filter((line) => line.includes("\t"))
		.slice(-NEWS_SHOWN)
		.map((line) => [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)] as [string, string]);
}

async function refresh($: Engine): Promise<void> {
	const f = folder;
	if (f === undefined || refreshing) return;
	refreshing = true;
	lastRefresh = await $.clock.now();
	try {
		const [status, where, news] = await Promise.all([get($, f, "/status"), get($, f, "/where"), newsOf($, f.root)]);
		const me = (status.agents ?? []).find((a: any) => a.agent === f.agent);
		const space: string = me?.draft ?? "shared";
		const draft = space === "shared" ? undefined : (status.drafts ?? []).find((d: any) => d.name === space);
		const files: string[] = Array.isArray(me?.files) ? me.files : [];
		const mine = new Set(files);
		const overlap = new Map<string, Set<string>>();
		for (const [file, entries] of Object.entries(where.files ?? {}) as [string, any[]][]) {
			if (!mine.has(file)) continue;
			for (const entry of entries) {
				if (entry.agent === f.agent) continue;
				overlap.set(entry.agent, (overlap.get(entry.agent) ?? new Set()).add(file));
			}
		}
		const next: AvcsView = {
			folder: { root: f.root, project: f.project, agent: f.agent },
			space,
			version: draft?.version ?? status.version,
			base: me?.base ?? null,
			files,
			changes: me?.draftChanges ?? 0,
			parked: (me?.parked ?? [])
				.filter((p: any) => p.draftChanges > 0)
				.map((p: any) => ({ space: p.draft ?? "shared", changes: p.draftChanges })),
			overlap: [...overlap].map(([agent, set]) => ({ agent, files: [...set].sort() })),
			news,
			at: lastRefresh,
			error: null,
		};
		await update($, view, () => next);
		$.ui.status(statusLine(next, await read($, seenNewsAt)));
	} catch (err) {
		const message = (err as Error).message;
		await update($, view, (old) => (old === null ? null : { ...old, error: message }));
		$.ui.status(`avcs: can't reach the server (${message})`);
	} finally {
		refreshing = false;
	}
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function unread(v: AvcsView, seen: string): number {
	return v.news.filter(([at]) => at > seen).length;
}

function statusLine(v: AvcsView, seen: string): string {
	const parts = [`avcs: ${v.space === "shared" ? "shared" : `draft ${v.space}`}`];
	parts.push(v.files.length === 0 ? "nothing unpublished" : `${plural(v.files.length, "file")} unpublished`);
	if (v.base !== null && v.base < v.version)
		parts.push(`${v.space === "shared" ? "shared" : "the draft"} is ${v.version - v.base} ahead (abso sync)`);
	if (v.overlap.length > 0) parts.push(`${v.overlap.map((o) => o.agent).join(", ")} also on your files`);
	const fresh = unread(v, seen);
	if (fresh > 0) parts.push(`${plural(fresh, "news item")} (/avcs-view)`);
	return parts.join(" · ");
}

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		await $.command.register({
			name: COMMAND,
			description: "Show this folder's abso state: space, draft, who else is on your files, news",
		});
		folder = await findFolder($, await $.session.cwd());
		if (folder !== undefined) {
			void refresh($);
			$.clock.every(TICK_MS, async () => {
				const now = await $.clock.now();
				const due = now - lastRefresh >= REFRESH_MS || (editedAt > lastRefresh && now - editedAt >= AFTER_EDIT_MS);
				if (due) void refresh($);
			});
		}
		return next(e);
	});

	on("tool.call", { tool: EDIT_TOOLS }, async ($, e, next) => {
		const ran = await next(e);
		if (folder !== undefined) editedAt = await $.clock.now();
		return ran;
	});

	on("command.run", { command: COMMAND }, async ($) => {
		if (folder === undefined)
			return { text: "This chat is not in an abso folder (no .avcs/config.json at or above its folder)." };
		await refresh($);
		await $.ui.open({ id: PANE, title: `avcs: ${folder.project} as ${folder.agent}` });
		// Opening the view reads the news: the status line stops counting it.
		const v = await read($, view);
		const newest = v?.news.at(-1)?.[0];
		if (v !== null && newest !== undefined) {
			await update($, seenNewsAt, () => newest);
			$.ui.status(statusLine(v, newest));
		}
		return { text: "Opened the avcs view." };
	});

	on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
		const { Box, Text } = $.ui.resolve(e);
		const v = await read($, view);
		if (v === null) return <Text dimColor>Asking the server...</Text>;
		return (
			<Box flexDirection="column">
				{v.error !== null && <Text color="red">The last refresh failed: {v.error}</Text>}
				<Text bold>
					{v.space === "shared" ? "Working in shared" : `Working in draft ${v.space}`}, at version {v.version}
					{v.base !== null && v.base < v.version
						? ` (your draft builds on ${v.base}; abso sync brings in the rest)`
						: ""}
				</Text>
				<Text> </Text>
				<Text bold>Your unpublished changes</Text>
				{v.files.length === 0 ? (
					<Text dimColor> None.</Text>
				) : (
					<Box flexDirection="column">
						<Text>
							{" "}
							{plural(v.changes, "change")} in {plural(v.files.length, "file")}:
						</Text>
						{v.files.slice(0, 20).map((file) => (
							<Text> {file}</Text>
						))}
						{v.files.length > 20 && <Text dimColor> and {v.files.length - 20} more</Text>}
					</Box>
				)}
				{v.parked.length > 0 && (
					<Text>
						{" "}
						Parked: {v.parked.map((p) => `${p.space} (${plural(p.changes, "change")})`).join(", ")}; abso switch brings
						it back.
					</Text>
				)}
				<Text> </Text>
				<Text bold>Others on your files</Text>
				{v.overlap.length === 0 ? (
					<Text dimColor> Nobody else has unpublished changes in them.</Text>
				) : (
					v.overlap.map((o) => (
						<Text>
							{" "}
							{o.agent}: {o.files.join(", ")}
						</Text>
					))
				)}
				<Text> </Text>
				<Text bold>News</Text>
				{v.news.length === 0 ? (
					<Text dimColor> None yet.</Text>
				) : (
					v.news.map(([at, line]) => (
						<Text>
							{"  "}
							{at.slice(11, 16)} {line}
						</Text>
					))
				)}
				<Text> </Text>
				<Text dimColor>Refreshed {new Date(v.at).toISOString().slice(11, 19)} UTC; every 30 s, and after edits.</Text>
			</Box>
		);
	});
};
