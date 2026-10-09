// Tell other agents something, as news. Writes go through AnnounceHost; today
// the host is Project.

import { agentAnnouncement, type NewsItem, personAnnouncement } from "./news.ts";
import { ProjectError } from "./project-error.ts";
import { checkPerson } from "./project-helpers.ts";
import type { AgentState, Entry } from "./project-types.ts";

/** What announcing needs from a project. */
export interface AnnounceHost {
	readonly agents: ReadonlyMap<string, AgentState>;
	announced(): number;
	setAnnounced(n: number): void;
	agent(name: string, entries: Entry[]): AgentState;
	queueNews(agent: AgentState, items: readonly NewsItem[], entries: Entry[]): void;
	apply(entry: Entry): void;
	flush(entries: Entry[]): void;
	needInit(): void;
}

/**
 * Tell other agents something, as news: "Announcement from <agent>:
 * <text>". It reaches each one with its next edit, record or news call.
 * `to` names agents; without it, every other agent the project has now.
 */
export function announce(
	host: AnnounceHost,
	agentName: string,
	text: string,
	to: readonly string[] | undefined,
	_time: number,
	how?: string,
): { id: number; to: string[] } {
	if (typeof text !== "string" || text.trim() === "") throw new ProjectError("bad-request", "announce needs {text}");
	if (text.length > 4000) throw new ProjectError("bad-request", "an announcement is at most 4000 characters");
	if (to !== undefined && (!Array.isArray(to) || !to.every((a) => typeof a === "string"))) {
		throw new ProjectError("bad-request", "to must be a list of agent names");
	}
	for (const name of to ?? []) {
		if (!host.agents.has(name)) throw new ProjectError("bad-request", `there is no agent ${JSON.stringify(name)}`);
	}
	const entries: Entry[] = [];
	const sender = host.agent(agentName, entries);
	const targets = [...new Set(to ?? [...host.agents.keys()].filter((a) => a !== sender.name))].toSorted();
	const id = host.announced() + 1;
	// "(as claimed)": every agent holds the same token, so the name is only
	// the one the sender's route gave (#31). A staging key says
	// which key (abso issue 103); claimMark allows only that wording.
	const sentence = agentAnnouncement(sender.name, claimMark(how), text);
	for (const name of targets)
		host.queueNews(host.agents.get(name)!, [{ key: `announce ${id}`, text: sentence }], entries);
	// Replay knows the number only from the news written, so it's taken only when some was.
	if (entries.some((e) => e.type === "news")) host.setAnnounced(id);
	host.flush(entries);
	return { id, to: targets };
}

/**
 * A signed-in person's announcement from the website (#41). The Worker has
 * checked who sent it; the engine records it on each recipient's news with
 * `from`, and never makes the person an agent. The text is JSON-quoted, so
 * a line break in it can't pass for another item.
 */
export function announcePerson(
	host: AnnounceHost,
	person: { id: unknown; name: unknown },
	text: string,
	to: readonly string[] | undefined,
	time: number,
): { id: number; to: string[] } {
	host.needInit();
	const from = checkPerson(person);
	const { id, name } = from.person;
	if (typeof text !== "string" || text.trim() === "") throw new ProjectError("bad-request", "announce needs {text}");
	if (text.length > 4000) throw new ProjectError("bad-request", "an announcement is at most 4000 characters");
	if (to !== undefined && (!Array.isArray(to) || !to.every((a) => typeof a === "string")))
		throw new ProjectError("bad-request", "to must be a list of agent names");
	for (const a of to ?? [])
		if (!host.agents.has(a)) throw new ProjectError("bad-request", `there is no agent ${JSON.stringify(a)}`);
	const targets = [...new Set(to ?? [...host.agents.keys()])].toSorted();
	const n = host.announced() + 1;
	const sentence = personAnnouncement(name, id, text);
	const entries: Entry[] = [];
	for (const target of targets) {
		const agent = host.agents.get(target)!;
		const key = `announce ${n}`;
		if (agent.told.has(key)) continue;
		const entry: Entry = { type: "news", agent: target, pairs: [key], text: [sentence], time, from };
		entries.push(entry);
		host.apply(entry);
	}
	if (entries.length > 0) host.setAnnounced(n);
	host.flush(entries);
	return { id: n, to: targets };
}

/** The announcement's parenthetical. Only these wordings, so a caller can't write the sentence. */
export function claimMark(how: string | undefined): "as claimed" | "shared token" | `key ${string}` {
	if (how === "shared token") return how;
	if (typeof how === "string" && /^key k_[0-9a-f]{8}(?:, box [A-Za-z0-9._-]{1,64})?$/.test(how))
		return how as `key ${string}`;
	return "as claimed";
}
