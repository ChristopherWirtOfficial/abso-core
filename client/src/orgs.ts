// Organizations from the CLI: abso orgs and abso org <name>. They read as the
// person who approved this box's sign-in (abso login). Changing an org (new,
// invite, role, remove, leave, settings) and making a project in one are done on
// the website for now: a box sits where agents run, and its sign-in was given
// for project work, so the server takes only reads from it.

import { type Parsed, UsageError } from "./args.ts";
import { type Answer, boxGet, originOf, readBox } from "./box.ts";
import type { Output } from "./commands.ts";

/** The website for an API server: api.<site> serves <site>; any other server serves its own pages. */
export function siteOf(server: string): string {
	try {
		const url = new URL(server);
		if (url.hostname.startsWith("api.")) url.hostname = url.hostname.slice("api.".length);
		return url.origin;
	} catch {
		return server;
	}
}

/** The flags that change an org, in the order Design wrote them; each names where the website does it. */
const CHANGES: readonly { flag: string; tab: string }[] = [
	{ flag: "invite", tab: "People" },
	{ flag: "role", tab: "People" },
	{ flag: "remove", tab: "People" },
	{ flag: "leave", tab: "People" },
	{ flag: "members", tab: "Settings" },
	{ flag: "projects-by", tab: "Settings" },
];

const WEBSITE_ONLY =
	"Organizations are changed on the website for now; from the CLI they can only be read, as the person who approved this box's sign-in";

/** Where the box's sign-in is read from and how the server is reached; tests pass their own. */
export interface OrgIo {
	readonly home?: string;
	readonly fetch?: typeof fetch;
}

async function read(server: string, path: string, io: OrgIo): Promise<Answer> {
	const record = io.home === undefined ? readBox(server) : readBox(server, io.home);
	if (!record)
		throw new UsageError(
			`this box isn't signed in to ${originOf(server)}. abso login signs it in; org reads answer as the person who approves it`,
		);
	return boxGet(record, path, io.fetch);
}

/** What a refusal from an org read means, in words. */
function refused(a: Answer, what: string, server: string): UsageError {
	const said = typeof a.body.error === "string" ? a.body.error : `status ${a.status}`;
	if (a.status === 401)
		return new UsageError(`${originOf(server)} didn't take this box's sign-in (${said}). abso login renews it`);
	if (a.status === 404 && /aren't on here/.test(said)) return new UsageError(`${originOf(server)}: ${said}`);
	if (a.status === 404) return new UsageError(`${what}: ${said}`);
	return new UsageError(`${originOf(server)} refused ${what} (${a.status}): ${said}`);
}

const when = (iso: unknown) => (typeof iso === "string" ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "?");

interface OrgRow {
	name: string;
	displayName: string;
	role: string;
}
interface Invitation {
	id: string;
	org: string;
	role: string;
	expiresAt: string;
}

/** abso orgs: your organizations, your role in each, and invitations waiting for you. */
export async function runOrgs(server: string, io: OrgIo = {}): Promise<Output> {
	const a = await read(server, "/orgs", io);
	if (a.status !== 200) throw refused(a, "the list of your organizations", server);
	const orgs = (a.body.orgs ?? []) as OrgRow[];
	const invitations = (a.body.invitations ?? []) as Invitation[];
	const lines =
		orgs.length === 0
			? ["You're in no organizations."]
			: [
					`Your organizations (${orgs.length}):`,
					...orgs.map(
						(o) => `  ${o.name}${o.displayName && o.displayName !== o.name ? ` (${o.displayName})` : ""}: ${o.role}`,
					),
				];
	if (invitations.length > 0)
		lines.push(
			"Invited to:",
			...invitations.map((i) => `  ${i.org} as ${i.role}, until ${when(i.expiresAt)}`),
			`Accept them on the website, signed in: ${siteOf(server)}.`,
		);
	return { text: lines.join("\n"), json: { orgs, invitations } };
}

interface Member {
	id: string;
	role: string;
	name: string | null;
	raised?: { project: string; role: string }[];
}
interface Invite {
	id: string;
	role: string;
	kind: "link" | "person";
	expiresAt: string;
}

/** abso org <name>, abso org new <name>, and the change flags, which say where the website does each. */
export async function runOrg(args: Parsed, server: string, io: OrgIo = {}): Promise<Output> {
	const [first, second, ...more] = args.positionals;
	const asked = CHANGES.filter((c) => args.flags.has(c.flag));
	if (first === "new") {
		if (second === undefined || more.length > 0) throw new UsageError('abso org new <name> [--name "<shown name>"]');
		throw new UsageError(`${WEBSITE_ONLY}. Make ${second} at ${siteOf(server)}/orgs/new.`);
	}
	if (first === undefined || second !== undefined)
		throw new UsageError("abso org <name> [one change], or abso org new <name>");
	if (args.flags.has("as") && !args.flags.has("invite")) throw new UsageError("--as goes with --invite");
	if (asked.length > 1)
		throw new UsageError(`one change at a time: --${asked.map((c) => c.flag).join(" and --")} were given together`);
	if (asked.length === 1)
		throw new UsageError(
			`${WEBSITE_ONLY}. --${asked[0]!.flag} is on ${first}'s ${asked[0]!.tab} tab: ${siteOf(server)}/${first}.`,
		);

	const a = await read(server, `/orgs/${encodeURIComponent(first)}`, io);
	if (a.status !== 200) throw refused(a, first, server);
	const org = a.body as {
		name: string;
		displayName: string;
		description: string | null;
		role?: string;
		membersCan?: string;
		whoMakesProjects?: string;
		members?: Member[];
		projects?: string[];
		invites?: Invite[];
	};
	const lines = [`${org.name}${org.displayName && org.displayName !== org.name ? ` (${org.displayName})` : ""}`];
	if (org.description) lines.push(`  ${org.description.replace(/\r?\n/g, "\n  ")}`);
	if (org.role === undefined) {
		lines.push("You aren't a member, so its people and settings aren't shown.");
		return { text: lines.join("\n"), json: { org } };
	}
	lines.push(
		`You're ${org.role === "owner" ? "an owner" : "a member"}. Members can ${org.membersCan ?? "?"} every project; ${org.whoMakesProjects === "owners" ? "only owners make" : "members make"} projects.`,
	);
	const projects = org.projects ?? [];
	lines.push(projects.length === 0 ? "Projects: none yet." : `Projects (${projects.length}): ${projects.join(", ")}`);
	const members = org.members ?? [];
	lines.push(`People (${members.length}):`);
	for (const m of members) {
		const raised = (m.raised ?? []).map((r) => `${r.role} in ${r.project}`);
		lines.push(
			`  ${m.name ?? "(no name yet)"}: ${m.role}${raised.length > 0 ? `, raised to ${raised.join(", ")}` : ""}`,
		);
	}
	if (org.invites !== undefined && org.invites.length > 0) {
		lines.push("Open invites:");
		for (const i of org.invites)
			lines.push(`  ${i.kind === "link" ? "a link" : "a person, by name"}, as ${i.role}, until ${when(i.expiresAt)}`);
	}
	return { text: lines.join("\n"), json: { org } };
}

/** abso init --org: making a project in an org is a website step for now. */
export function initInOrg(org: string, server: string): never {
	throw new UsageError(
		`projects in an organization are made on the website for now: New project at ${siteOf(server)}, with ${org} as its owner.`,
	);
}
