// A visitor folder: abso join <project> --reader with no sign-in, for a public project. It reads the
// project through the routes anyone can read, and sends no credential, whatever the environment holds
// (config.ts reads no token for it, and Api sends none and follows no redirect). Which commands it runs
// is a list of reads: anything not on it is refused here, before any call, so a new command stays
// refused until someone adds it. The server refuses writes from it too; this is so the refusal is plain.

import { type Parsed, UsageError } from "./args.ts";

/** The commands a visitor folder runs, each with the flags it takes there. */
export const VISITOR_READS: Readonly<Record<string, readonly string[]>> = {
	status: [],
	log: ["limit", "before", "draft", "since", "by", "count"],
	show: ["draft"],
	files: ["draft", "version"],
	blame: ["from", "to", "version", "draft"],
	why: ["draft"],
	where: [],
	issues: ["open", "status", "agent", "parent", "label", "labels"],
	issue: [],
	search: ["limit"],
};

/** Commands about this box, not the folder: they work from anywhere, a visitor folder too. */
export const VISITOR_ELSEWHERE: readonly string[] = ["login", "logout"];

/** Flags every command takes (--server is checked against the folder's own server before this, in main.ts). */
const EVERY = new Set(["json", "help", "server"]);

export function visitorRefusal(project: string): string {
	return `This folder reads ${project} signed out. To work on it: abso login, then abso join ${project} in a new folder.`;
}

/** Refuses, before any call, a command or a flag a visitor folder doesn't run. */
export function checkVisitor(command: string, args: Parsed, project: string): void {
	if (VISITOR_ELSEWHERE.includes(command)) return;
	const flags = VISITOR_READS[command];
	if (flags === undefined) throw new UsageError(visitorRefusal(project));
	for (const name of args.flags.keys())
		if (!EVERY.has(name) && !flags.includes(name))
			throw new UsageError(`${visitorRefusal(project)} Here, ${command} reads only; --${name} isn't one of its reads.`);
	// abso issue new and abso issue draft write: here, issue takes only a number.
	if (command === "issue" && !(args.positionals.length === 1 && /^#?\d+$/.test(args.positionals[0]!)))
		throw new UsageError(`${visitorRefusal(project)} Here, issue reads one issue: abso issue <N>.`);
}
