// The JSON routes of the contract (docs/v2-slice1.md), as a pure function of
// the project calls, so they can be tested in Node without a Worker.

import type { EditBody, ProjectCalls, ProjectHistory } from "./project-api.ts";
import { unseenError } from "./unseen.ts";

export interface Answer {
	status: number;
	body: unknown;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validName(name: string | undefined): name is string {
	return name !== undefined && NAME.test(name);
}

/**
 * The call's answer, or undefined when `ms` passes or the call fails.
 * The call keeps running either way: this only bounds how long the caller waits.
 */
export function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

const fail = (status: number, error: string): Answer => ({ status, body: { error } });

/**
 * Agents that read everything and record nothing (#37, Reporter). Kept by the
 * caller outside the log: a refused call writes nothing, so replay never
 * needs it, and an older Worker can still load the log.
 */
export interface Readers {
	has(agent: string): boolean;
	set(agent: string, reader: boolean): void;
	list(): string[];
}

/**
 * What a reader may not do. Edits and records (which old edit mods send on
 * their own) and publishes answer 200 {ok: false, reason}, so a mod only logs
 * it; the rest are refused outright.
 */
const NOT_FOR_READERS: Record<string, "answer" | "refuse"> = {
	edit: "answer",
	record: "answer",
	publish: "answer",
	land: "answer",
	pluck: "answer",
	"draft-sync": "refuse",
	drop: "refuse",
	amend: "refuse",
	label: "refuse",
	starting: "refuse",
	move: "refuse",
};

/** A path the project won't hold: .avcs/ is each folder's own settings. */
/** A path under a folder's state folder (.abso/, or .avcs/ from before the rename), which never leaves it. */
function localPath(paths: string[]): string | undefined {
	return paths.find((p) => [".abso", ".avcs"].some((d) => p === d || p.startsWith(`${d}/`) || p.startsWith(`./${d}/`)));
}
const LOCAL = (p: string) =>
	fail(400, `${p} is under ${p.replace(/^\.\//, "").split("/")[0]}/, which stays in the agent's folder`);

/**
 * The reader rules (#37, Reporter), for one agent call: the answer to
 * `reader {reader}`, or the refusal of something a reader may not do, or
 * undefined when the call goes ahead. An agent holding unpublished work
 * can't become a reader.
 */
export function readerAnswer(
	project: { status(): unknown },
	op: string,
	agent: string,
	body: unknown,
	readers: Readers,
): Answer | undefined {
	if (op === "reader") {
		const on = (body as { reader?: unknown } | undefined)?.reader;
		if (typeof on !== "boolean") return fail(400, "reader needs {reader: true} or {reader: false}");
		if (on) {
			const me = (
				project.status() as { agents?: { agent: string; draftChanges: number; parked?: unknown[] }[] }
			).agents?.find((a) => a.agent === agent);
			if (me && (me.draftChanges > 0 || (me.parked?.length ?? 0) > 0)) {
				return fail(
					409,
					`${agent} has unpushed changes; push or restore them (abso restore --all) before it becomes a reader`,
				);
			}
		}
		readers.set(agent, on);
		return { status: 200, body: { agent, reader: on } };
	}
	const barred = readers.has(agent) ? NOT_FOR_READERS[op] : undefined;
	if (!barred) return undefined;
	const reason = `agent ${agent} is a reader: it records nothing (abso join --reader)`;
	if (barred === "refuse") return fail(403, reason);
	return { status: 200, body: { ok: false, reason, ...(op === "edit" || op === "record" ? {} : { collisions: [] }) } };
}

/** The status answer with readers marked on their agent entries and listed (#37). */
export function statusWithReaders(status: unknown, readers: Readers | undefined): unknown {
	const s = status as { agents?: { agent: string }[] };
	if (!readers || readers.list().length === 0) return s;
	return {
		...s,
		agents: (s.agents ?? []).map((a) => (readers.has(a.agent) ? { ...a, reader: true } : a)),
		readers: readers.list(),
	};
}

/** op is "init", "status", or an agent op ("edit", "record", "publish", "sync"). */
export function answer(
	project: ProjectCalls,
	op: string,
	agent: string | undefined,
	body: unknown,
	readers?: Readers,
	how?: string,
): Answer {
	try {
		if (op === "init") {
			const files = (body as { files?: Record<string, string> })?.files;
			if (!files || typeof files !== "object") return fail(400, "init needs {files: {path: text}}");
			if (project.exists()) return fail(409, "the project already exists");
			const bad = localPath(Object.keys(files));
			if (bad) return LOCAL(bad);
			const modes = (body as { modes?: unknown })?.modes;
			if (modes !== undefined && (typeof modes !== "object" || modes === null))
				return fail(400, "modes must be {path: {exec, link}}");
			const blobs = (body as { blobs?: unknown })?.blobs;
			if (blobs !== undefined && (typeof blobs !== "object" || blobs === null))
				return fail(400, "blobs must be {path: sha256}");
			if (blobs && localPath(Object.keys(blobs))) return LOCAL(localPath(Object.keys(blobs))!);
			return {
				status: 200,
				body: project.init(
					files,
					modes as Record<string, { exec?: boolean; link?: string | null }> | undefined,
					blobs as Record<string, string> | undefined,
				),
			};
		}
		if (!project.exists()) return fail(404, "no such project; run init first");
		// Readers (#37): marked on their agent entries, and listed even before their first sync.
		// Reads for the website (#41): ?at=<log position> replays status and where as they stood then.
		const atOf = (): number | undefined => {
			const at = (body as { at?: string } | undefined)?.at;
			return at !== undefined && at !== "" && Number.isInteger(Number(at)) && Number(at) >= 0 ? Number(at) : undefined;
		};
		if (op === "status" && agent === undefined) {
			const at = atOf();
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (at !== undefined)
				return history.statusAt
					? { status: 200, body: history.statusAt(at) }
					: fail(501, "status at a log position needs the engine");
			return { status: 200, body: statusWithReaders(project.status(), readers) };
		}
		if (op === "where") {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.where) return fail(501, "where needs the engine");
			const at = atOf();
			if (at !== undefined)
				return history.whereAt
					? { status: 200, body: history.whereAt(at) }
					: fail(501, "where at a log position needs the engine");
			return { status: 200, body: history.where() };
		}
		if (op === "changes" || op.startsWith("change/")) {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.change || !history.changes) return fail(501, `${op} needs the engine`);
			const q = (body ?? {}) as Record<string, string | undefined>;
			if (op !== "changes") return { status: 200, body: history.change(Number(op.slice("change/".length))) };
			const since = q.since === undefined || q.since === "" ? 0 : Number(q.since);
			const limit = q.limit === undefined || q.limit === "" ? 50 : Number(q.limit);
			if (!Number.isInteger(since) || since < 0) return fail(400, "changes needs ?since=<log position>");
			if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit is 1-200");
			const before = q.before === undefined || q.before === "" ? undefined : Number(q.before);
			if (before !== undefined && (!Number.isInteger(before) || before < 0))
				return fail(400, "before must be a log position");
			// ?issue= (#54): the changes whose start note named that issue.
			if (q.issue !== undefined && q.issue !== "" && !/^[1-9]\d{0,9}$/.test(q.issue))
				return fail(400, "issue must be an issue number");
			return { status: 200, body: history.changes(since, limit, before, q.issue ? Number(q.issue) : undefined) };
		}
		if (op === "notes") {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.notes) return fail(501, "notes needs the engine");
			const q = (body ?? {}) as Record<string, string | undefined>;
			if (q.change !== undefined && !/^\d+$/.test(q.change)) return fail(400, "change must be a change id");
			return {
				status: 200,
				body: history.notes({
					...(q.file ? { file: q.file } : {}),
					...(q.change ? { change: Number(q.change) } : {}),
					...(q.open === "1" || q.open === "true" ? { open: true } : {}),
				}),
			};
		}
		if (op === "position") {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.position) return fail(501, "position needs the engine");
			const q = (body ?? {}) as Record<string, string | undefined>;
			if (q.version !== undefined && q.version !== "") {
				if (!/^\d+$/.test(q.version)) return fail(400, "version must be a version number");
				return { status: 200, body: history.position({ version: Number(q.version) }) };
			}
			if (q.time === undefined || q.time === "")
				return fail(400, "position needs ?time=<ISO time or ms since 1970> or ?version=<n>");
			const time = /^\d+$/.test(q.time) ? Number(q.time) : Date.parse(q.time);
			if (!Number.isFinite(time)) return fail(400, "time is an ISO time or ms since 1970");
			return { status: 200, body: history.position({ time }) };
		}
		if (op === "ribbon") {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.ribbon) return fail(501, "ribbon needs the engine");
			return { status: 200, body: history.ribbon() };
		}
		if (op === "feed" || op === "drafts" || (op === "diff" && agent === undefined)) {
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.feed || !history.drafts || !history.diffOf) return fail(501, `${op} needs the engine`);
			if (op === "drafts") return { status: 200, body: history.drafts() };
			if (op === "diff") {
				if (!q.agent) return fail(400, "diff needs ?agent=<name>");
				return { status: 200, body: history.diffOf(q.agent) };
			}
			const from = q.from === undefined || q.from === "" ? 0 : Number(q.from);
			const limit = q.limit === undefined || q.limit === "" ? 500 : Number(q.limit);
			if (!Number.isInteger(from) || from < 0) return fail(400, "feed needs ?from=<log position>");
			if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return fail(400, "limit is 1-2000");
			return { status: 200, body: history.feed(from, limit) };
		}
		if (op === "draft-state") {
			// A named draft's state in one read (#41, the Drafts page): base, behind, versions, first edit, collisions.
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.draftState) return fail(501, "draft-state needs the engine");
			const q = (body ?? {}) as Record<string, string | undefined>;
			if (!q.name) return fail(400, "draft-state needs ?name=<draft>");
			return { status: 200, body: history.draftState(q.name) };
		}
		if (
			op === "tree" ||
			op === "path" ||
			op === "follow" ||
			op === "collisions" ||
			(op === "blame" && (body as { folder?: unknown } | undefined)?.folder !== undefined)
		) {
			// Reads for the Files pages (#41): GETs, the body is the query string.
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.tree || !history.pathLife || !history.follow || !history.collisions || !history.folderBlame)
				return fail(501, `${op} needs the engine`);
			const int = (s: string | undefined): number | undefined | null =>
				s === undefined || s === "" ? undefined : /^\d+$/.test(s) ? Number(s) : null;
			const version = int(q.version);
			if (version === null) return fail(400, "version must be a version number");
			const draft = q.draft || null;
			if (op === "blame")
				return {
					status: 200,
					body: history.folderBlame(q.folder ?? "", version, q.draft || undefined, q.agent || undefined),
				};
			// agent= (#41, F25): the folder as that agent has it; authors=1 (F33): each entry's authors in the same read.
			if (op === "tree") {
				if (q.authors !== undefined && q.authors !== "" && q.authors !== "1")
					return fail(400, "authors is 1 or left out");
				return {
					status: 200,
					body: history.tree(q.folder ?? "", version, draft, q.agent || undefined, q.authors === "1"),
				};
			}
			if (op === "collisions")
				return { status: 200, body: history.collisions(q.file || undefined, q.folder || undefined) };
			if (!q.path) return fail(400, `${op} needs ?path=<path>`);
			if (op === "path") return { status: 200, body: history.pathLife(q.path, version, draft) };
			const from = int(q.from);
			const to = int(q.to) ?? from;
			const at = int(q.at);
			if (
				version === undefined ||
				from === undefined ||
				from === null ||
				to === null ||
				to === undefined ||
				at === null
			)
				return fail(400, "follow needs ?path=&version=&from=, and ?to= and ?at= if wanted");
			return { status: 200, body: history.follow(q.path, version, from, to, at, draft) };
		}
		if (op === "blame" || op === "why") {
			// GETs: the body is the query string as {file, from, to, line}.
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!q.file) return fail(400, `${op} needs ?file=<path>, or blame ?folder=<path> ("" for the whole project)`);
			if (!history.blame || !history.why) return fail(501, `${op} needs the engine`);
			const num = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number(s));
			const draft = q.draft || undefined;
			const who = q.agent || undefined;
			if (op === "blame")
				return { status: 200, body: history.blame(q.file, num(q.from), num(q.to), num(q.version), draft, who) };
			const line = num(q.line);
			if (!line || !Number.isInteger(line)) return fail(400, "why needs ?line=<number>");
			return { status: 200, body: history.why(q.file, line, draft, who) };
		}
		if (op === "announce" && agent === undefined) {
			// The sender comes from the route, like every other agent op, not from
			// a body field anyone can fill in (#31).
			return fail(400, "announce from your own agent: POST /p/:project/a/<you>/announce {text, to?}");
		}
		if (op === "files" && agent === undefined) {
			// GET ?version=&draft=: the paths in shared (or a named draft) at a version.
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			// ?agent=: the files as an agent has them (#41, F25), read only, so an unknown agent is 404.
			if (q.agent !== undefined) {
				if (!history.pathsOf) return fail(501, "files?agent= needs the engine");
				return { status: 200, body: history.pathsOf(q.agent) };
			}
			if (!history.pathsAt) return fail(501, "files needs the engine");
			const version = q.version !== undefined && q.version !== "" ? Number(q.version) : undefined;
			if (version !== undefined && !Number.isInteger(version)) return fail(400, "version must be a number");
			return { status: 200, body: history.pathsAt(version, q.draft || null) };
		}
		if (op === "labels") {
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.labels) return fail(501, "labels needs the engine");
			return { status: 200, body: history.labels() };
		}
		if (op === "refusals") {
			// GET ?agent=<name>&limit=<n>: refused publishes and lands, newest first, and counts.
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.refusals) return fail(501, "refusals needs the engine");
			const limit = q.limit !== undefined && Number.isInteger(Number(q.limit)) ? Number(q.limit) : undefined;
			return { status: 200, body: history.refusals(q.agent || undefined, limit) };
		}
		if (op === "log" || op === "show" || op === "file" || op === "compare") {
			// GETs: ?draft=<name> (shared when absent); log ?limit, ?path; show ?version; file ?path, ?version; compare ?from, ?to.
			const q = (body ?? {}) as Record<string, string | undefined>;
			const history = project as ProjectCalls & Partial<ProjectHistory>;
			if (!history.log || !history.show || !history.fileAt || !history.compare)
				return fail(501, `${op} needs the engine`);
			const draft = q.draft ? q.draft : null;
			const int = (s: string | undefined): number | undefined =>
				s !== undefined && s !== "" && Number.isInteger(Number(s)) ? Number(s) : undefined;
			const who = q.agent || undefined;
			if (op === "log")
				return {
					status: 200,
					body: history.log(
						draft,
						int(q.limit),
						q.path || undefined,
						who,
						int(q.before),
						q.follow === "1" || q.follow === "true",
					),
				};
			if (op === "file") {
				const version = int(q.version);
				if (!q.path || version === undefined) return fail(400, "file needs ?path=<path>&version=<number>");
				return { status: 200, body: history.fileAt(q.path, version, draft, who) };
			}
			if (op === "compare") {
				const from = int(q.from);
				const to = int(q.to);
				if (from === undefined || to === undefined) return fail(400, "compare needs ?from=<number>&to=<number>");
				return { status: 200, body: history.compare(from, to, draft, who) };
			}
			const version = Number(q.version);
			if (q.version === undefined || !Number.isInteger(version)) return fail(400, "show needs ?version=<number>");
			return { status: 200, body: history.show(version, draft, who) };
		}
		if (!validName(agent)) return fail(400, "agent names use letters, digits, '.', '_' and '-'");
		if (op === "reader" && !readers) return fail(501, "reader needs the Worker");
		const gated = readers ? readerAnswer(project, op, agent, body, readers) : undefined;
		if (gated) return gated;
		switch (op) {
			case "edit": {
				const b = body as EditBody;
				if (!b || typeof b.file !== "string")
					return fail(400, "edit needs {file, old, new}, {file, content} or {file, edits}");
				if (localPath([b.file])) return LOCAL(b.file);
				return { status: 200, body: project.edit(agent, b) };
			}
			case "record": {
				const files = (body as { files?: Record<string, string | null> })?.files;
				if (!files || typeof files !== "object") return fail(400, "record needs {files: {path: text or null}}");
				const bad = localPath(Object.keys(files));
				if (bad) return LOCAL(bad);
				const modes = (body as { modes?: unknown })?.modes;
				if (modes !== undefined && (typeof modes !== "object" || modes === null))
					return fail(400, "modes must be {path: {exec, link}}");
				const blobs = (body as { blobs?: unknown })?.blobs;
				if (blobs !== undefined && (typeof blobs !== "object" || blobs === null))
					return fail(400, "blobs must be {path: sha256}");
				if (blobs && localPath(Object.keys(blobs))) return LOCAL(localPath(Object.keys(blobs))!);
				const who = body as { session?: unknown; subagent?: unknown; client?: unknown };
				const meta = {
					...(typeof who.session === "string" ? { session: who.session } : {}),
					...(typeof who.subagent === "string" ? { subagent: who.subagent } : {}),
					...(typeof who.client === "string" ? { client: who.client } : {}),
				};
				return {
					status: 200,
					body: project.record(
						agent,
						files,
						modes as Record<string, { exec?: boolean; link?: string | null }> | undefined,
						blobs as Record<string, string> | undefined,
						meta,
					),
				};
			}
			case "publish": {
				const message = (body as { message?: string })?.message;
				if (typeof message !== "string" || !message.trim()) return fail(400, "push needs {message} saying why");
				const unseen = unseenError("the message", message);
				if (unseen) return fail(400, unseen);
				// asIs (#37): publish even with collided lines untouched since the sync, both sides kept.
				return { status: 200, body: project.publish(agent, message, (body as { asIs?: unknown }).asIs === true) };
			}
			case "sync": {
				// {label}: follow a label (#10), syncing to the newest version of shared that carries it.
				const label = (body as { label?: unknown } | undefined)?.label;
				if ((body as { full?: unknown } | undefined)?.full === true) {
					// {full: true}: every file in the agent's view, as a first sync answers (#37).
					const history = project as ProjectCalls & Partial<ProjectHistory>;
					if (!history.syncFull) return fail(501, "a full pull needs the engine");
					if (label !== undefined && typeof label !== "string") return fail(400, "label must be a label name");
					return { status: 200, body: history.syncFull(agent, label as string | undefined) };
				}
				if (label === undefined) return { status: 200, body: project.sync(agent) };
				if (typeof label !== "string") return fail(400, "label must be a label name");
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.syncTo) return fail(501, "following a label needs the engine");
				return { status: 200, body: history.syncTo(agent, label) };
			}
			case "label": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.label) return fail(501, "label needs the engine");
				const b = (body ?? {}) as { name?: unknown; version?: unknown; remove?: unknown };
				if (typeof b.name !== "string") return fail(400, "label needs {name}, and {version} unless it's the newest");
				if (b.version !== undefined && !Number.isInteger(b.version)) return fail(400, "version must be a number");
				return { status: 200, body: history.label(agent, b.name, b.version as number | undefined, b.remove === true) };
			}
			// Named drafts (#10).
			case "draft": {
				const name = (body as { name?: unknown })?.name;
				if (name !== null && typeof name !== "string")
					return fail(400, "draft needs {name}, or {name: null} for shared");
				return { status: 200, body: project.switchTo(agent, name, (body as { carry?: unknown }).carry === true) };
			}
			case "land": {
				const message = (body as { message?: string })?.message;
				if (typeof message !== "string" || !message.trim()) return fail(400, "land needs {message} saying why");
				const unseen = unseenError("the message", message);
				if (unseen) return fail(400, unseen);
				return { status: 200, body: project.land(agent, message) };
			}
			case "draft-sync":
				return { status: 200, body: project.syncDraft(agent) };
			// The paths in the agent's view (#37): what its folder should hold. A GET; changes nothing.
			case "files": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.agentPaths) return fail(501, "files needs the engine");
				return { status: 200, body: history.agentPaths(agent) };
			}
			// abso status in one trip (abso issue 80): the project's status and the agent's paths.
			case "status": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.agentPaths) return fail(501, "status needs the engine");
				return {
					status: 200,
					body: { ...(statusWithReaders(project.status(), readers) as object), files: history.agentPaths(agent) },
				};
			}
			// Amend (#27): correct the message of the agent's newest publish.
			case "amend": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.amend) return fail(501, "amend needs the engine");
				const message = (body as { message?: unknown } | undefined)?.message;
				if (typeof message !== "string" || !message.trim()) return fail(400, "amend needs {message}");
				const unseen = unseenError("the message", message);
				if (unseen) return fail(400, unseen);
				return { status: 200, body: history.amend(agent, message) };
			}
			// Pluck (#27): take some versions of a named draft into shared.
			case "pluck": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.pluck) return fail(501, "pluck needs the engine");
				const b = (body ?? {}) as {
					draft?: unknown;
					versions?: unknown;
					message?: unknown;
					withDependencies?: unknown;
				};
				if (typeof b.draft !== "string") return fail(400, "pluck needs {draft, versions: [number], message}");
				if (!Array.isArray(b.versions) || b.versions.length === 0 || !b.versions.every((v) => Number.isInteger(v)))
					return fail(400, "pluck needs {versions: [number]}");
				if (typeof b.message !== "string" || !b.message.trim()) return fail(400, "pluck needs {message} saying why");
				const unseen = unseenError("the message", b.message);
				if (unseen) return fail(400, unseen);
				return {
					status: 200,
					body: history.pluck(agent, b.draft, b.versions as number[], b.message, b.withDependencies === true),
				};
			}
			// Drop (#10): take published versions out of shared.
			case "drop": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.drop) return fail(501, "drop needs the engine");
				const b = (body ?? {}) as { versions?: unknown; message?: unknown; withDependents?: unknown };
				if (!Array.isArray(b.versions) || b.versions.length === 0 || !b.versions.every((v) => Number.isInteger(v)))
					return fail(400, "drop needs {versions: [number], message}");
				if (typeof b.message !== "string" || !b.message.trim()) return fail(400, "drop needs {message} saying why");
				const unseen = unseenError("the message", b.message);
				if (unseen) return fail(400, unseen);
				return { status: 200, body: history.drop(agent, b.versions as number[], b.message, b.withDependents === true) };
			}
			// Announcements, and news without an edit.
			case "move": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.move) return fail(501, "move needs the engine");
				const b = (body ?? {}) as { from?: unknown; to?: unknown };
				if (typeof b.from !== "string" || typeof b.to !== "string") return fail(400, "move needs {from, to}");
				if (localPath([b.from, b.to])) return LOCAL(localPath([b.from, b.to])!);
				return { status: 200, body: history.move(agent, b.from, b.to) };
			}
			case "note":
			case "note-close": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.note || !history.closeNote) return fail(501, `${op} needs the engine`);
				const b = (body ?? {}) as Record<string, unknown>;
				if (op === "note-close") return { status: 200, body: history.closeNote(agent, b.id as number, b.how) };
				const unseen = unseenError("the note", b.text);
				if (unseen) return fail(400, unseen);
				return { status: 200, body: history.note(agent, b) };
			}
			case "announce":
			case "news": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.announce || !history.news) return fail(501, `${op} needs the engine`);
				if (op === "news") return { status: 200, body: history.news(agent) };
				const b = (body ?? {}) as { text?: unknown; to?: unknown };
				if (typeof b.text !== "string" || !b.text.trim()) return fail(400, "announce needs {text}");
				const unseen = unseenError("the text", b.text);
				if (unseen) return fail(400, unseen);
				if (b.to !== undefined && (!Array.isArray(b.to) || !b.to.every((a) => typeof a === "string")))
					return fail(400, "to must be a list of agent names");
				return { status: 200, body: history.announce(agent, b.text, b.to as string[] | undefined, how) };
			}
			// What the agent is starting on (#37, #13): {text, files?}, or {text: null} to take it back.
			case "starting": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.starting) return fail(501, "starting needs the engine");
				const b = (body ?? {}) as { text?: unknown; files?: unknown; issue?: unknown; done?: unknown };
				if (b.text !== null && (typeof b.text !== "string" || !b.text.trim()))
					return fail(400, "starting needs {text}, or {text: null} to take it back");
				const unseen = unseenError("the note", b.text);
				if (unseen) return fail(400, unseen);
				if (b.files !== undefined && (!Array.isArray(b.files) || !b.files.every((f) => typeof f === "string")))
					return fail(400, "files must be a list of paths");
				// issue (#54): the issue the note works on; done: a take-back because the work is finished, closing it.
				return {
					status: 200,
					body: history.starting(agent, b.text as string | null, b.files as string[] | undefined, {
						...(b.issue !== undefined ? { issue: b.issue } : {}),
						...(b.done !== undefined ? { done: b.done } : {}),
					}),
				};
			}
			// Everyday commands (#27).
			case "diff":
			case "restore": {
				const history = project as ProjectCalls & Partial<ProjectHistory>;
				if (!history.diff || !history.restore) return fail(501, `${op} needs the engine`);
				if (op === "diff") return { status: 200, body: history.diff(agent) };
				const b = (body ?? {}) as { files?: unknown; all?: unknown };
				if (b.all === true) return { status: 200, body: history.restore(agent, null) };
				if (!Array.isArray(b.files) || !b.files.every((f) => typeof f === "string")) {
					return fail(400, "restore needs {files: [path]} or {all: true}");
				}
				return { status: 200, body: history.restore(agent, b.files as string[]) };
			}
		}
		return fail(404, `no such operation: ${op}`);
	} catch (e) {
		// The engine throws ProjectError with a code; anything else is ours.
		const code = (e as { code?: string }).code;
		const status =
			code === "not-implemented"
				? 501
				: code === "not-initialized" || code === "not-found"
					? 404
					: code === "already-initialized" || code === "conflict"
						? 409
						: code === "bad-request" || code === "bad-agent"
							? 400
							: 500;
		return fail(status, e instanceof Error ? e.message : String(e));
	}
}
