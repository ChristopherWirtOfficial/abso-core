// What Issues answers and takes over HTTP (abso issues 54 and 141): the
// client reads these shapes, and the Issues Worker's store writes them. They
// sit with the client, the open tool, so the platform imports them from here
// and the tool never imports the platform.

export type Status = "open" | "in progress" | "in review" | "blocked" | "done" | "dropped";

/** Who is acting: an agent through the client, or a signed-in person through the website. */
export type Actor = { agent: string } | { person: string };

export interface Lines {
	file: string;
	from: number;
	to: number;
	version: number;
}

export interface IssueRow {
	id: number;
	title: string;
	parent: number | null;
	status: Status;
	/** Who it's for: set when it's written or edited, else the first agent whose start note named it. */
	agent: string | null;
	/** The agents whose start notes name it now. */
	agents: string[];
	/** Issues it waits on: it's Blocked until each is Done. */
	blockedBy: number[];
	/** Its labels, sorted: friction, client, and the like. */
	labels: string[];
	/** Versions of shared published for it, oldest first. */
	versions: number[];
	/** Who its open asks wait on (an agent, or person:<id>). */
	waitingOn: string[];
	opened: { by: string; at: number };
	/** The latest claim, publish, comment, ask, answer or close. */
	updated: number;
	closed: { how: "done" | "dropped"; by: string; version: number | null; at: number } | null;
	children: number;
}

export interface Comment {
	id: number;
	by: string;
	kind: "comment" | "objection";
	text: string;
	at: number;
	/** Images it carries (abso issue 171); left out when none. */
	attachments?: Attachment[];
}

/** An image on an issue or comment (abso issue 171): GET /p/:project/attachments/<id> serves it. */
export interface Attachment {
	/** "a" and the first 12 hex of its sha256: what a text points at. */
	id: string;
	name: string;
	type: string;
	size: number;
	/** The SVG an image was drawn from, when it was one: the server serves the image as a PNG, and this only as a download at attachments/<id>/source. */
	source?: { name: string; size: number };
}

export interface Ask {
	id: number;
	/** The issue it's on; none for a decision that belongs to no issue. */
	issue: number | null;
	by: string;
	of: string;
	kind: "question" | "task";
	question: string;
	/** Files the question carries; absent when none, and from older servers. */
	attachments?: Attachment[];
	review: boolean;
	due: string | null;
	recommendation: { text: string; by: string } | null;
	options: string[];
	/** Issues it holds up, besides its own. */
	blocks: number[];
	at: number;
	/** Its answer; for a withdrawn ask, the asker's note on why, with the asker as `by`. */
	answer: { by: string; words: string; at: number; attachments?: Attachment[] } | null;
	/** When waiting first listed it to the one it's asked of; null until then (abso issue 124). */
	seen: number | null;
	/** "withdrawn" when the asker took it back; absent for an open or answered ask, and from older servers. */
	outcome?: "withdrawn";
	/** When the one asked acknowledged it without answering yet, with their note; it stays open. Absent until then. */
	ack?: { at: number; note: string };
}

export interface Claim {
	agent: string;
	change: number;
	since: number;
}

export interface IssuePage {
	issue: IssueRow & { description: string; lines: Lines | null; watchers: string[]; attachments?: Attachment[] };
	comments: Comment[];
	edits: Edit[];
	asks: Ask[];
	claims: Claim[];
	children: IssueRow[];
}

/** What a write tells the people working on an issue; the avcs Worker sends it. */
export interface News {
	issue: number | null;
	text: string;
	/** Besides the issue's agents: who else hears it (the one asked, or the asker). */
	to?: string[];
}

/** One edit, in the issue's activity: each field it changed, from and to, and who was told. */
export interface Edit {
	id: number;
	by: string;
	changes: Partial<
		Record<"title" | "description" | "parent" | "agent" | "blockedBy" | "labels", { from: unknown; to: unknown }>
	>;
	/** Who heard it: the watchers and anyone added, or nobody when the writer said not to notify. */
	notified: string[];
	at: number;
}

/** A new issue's form as it was left: open's fields, any of them still empty. */
export interface DraftBody {
	title?: string;
	description?: string;
	parent?: number | null;
	lines?: Lines | null;
	agent?: string | null;
	blockedBy?: number[];
	notify?: string[];
	labels?: string[];
}

/** An issue not opened yet: its writer's alone, with no number, and no news. */
export interface Draft {
	id: number;
	body: DraftBody;
	saved: number;
}

/** One issue search hit: the issue, where it matched, a few words around it. */
export interface IssueSearchHit {
	issue: { id: number; title: string; status: Status; updated: number; labels: string[] };
	where: "title" | "description" | "comment";
	comment?: number;
	/** The words around the match; char(1) and char(2) bracket each matched span. */
	snippet: string;
	/** Only meaning search found it: the words differ, the meaning matches. */
	meaning?: true;
}
