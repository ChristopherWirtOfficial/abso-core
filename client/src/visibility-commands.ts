// abso visibility (abso issues 152 and 140): see or switch whether the project is public.
// A public project can be read by anyone, signed in or not, and not only its members.
import { bool, type Parsed, UsageError } from "./args.ts";
import { type Env, type Output, open } from "./commands.ts";

/** What going public shows, said plainly before it happens (152). */
const PUBLIC_SHOWS =
	"Anyone, signed in or not, can then read its files, versions, log, drafts, notes, Issues and the names of the people in it, and see CI as pass or fail. Never its keys, CI logs, preview links, boxes or anyone's news.";

export async function runVisibility(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1) throw new UsageError("visibility takes at most one word: public or private");
	const want = args.positionals[0];
	const { api } = open(env);
	if (want === undefined) {
		const now = await api.visibility();
		return {
			text: `${now.project} is ${now.visibility}.${now.visibility === "public" ? ` ${PUBLIC_SHOWS}` : " Only its members can read it."}`,
			json: now,
		};
	}
	if (want !== "public" && want !== "private")
		throw new UsageError("visibility is public or private, for example: abso visibility public --yes");
	if (want === "public" && !bool(args, "yes"))
		throw new UsageError(
			`Making the project public shows it to anyone at once. ${PUBLIC_SHOWS} Run abso visibility public --yes to do it.`,
		);
	const set = await api.setVisibility(want);
	return {
		text:
			set.visibility === "public"
				? `${set.project} is public now. ${PUBLIC_SHOWS} abso visibility private makes it private again.`
				: `${set.project} is private now: only its members can read it.`,
		json: set,
	};
}
