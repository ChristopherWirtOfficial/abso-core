// Where a push came from in git, when it was imported (abso-core issue 21).
// A version imported by client/scripts/import-git.ts ends its message with
// a line naming the commit, its author and its time, and, when the
// repository's issues are on the web, a line saying where:
//
//   git 4e1a7c2b9f03, Ada Lovelace, 2026-10-06T20:36:43-05:00
//   Issues: https://github.com/owner/repo/issues
//
// A commit pushed with plain git ends with "Git-Commit: <sha>" and
// "Author: <name>". A host may also name the commit beside the version
// (`commit`). Issue references like "#39" in an imported message, or in a
// line it wrote, mean that repository's issues, not the project's.

export interface GitOrigin {
	readonly commit: string;
	readonly author?: string;
	readonly time?: string;
	/** The repository's issues, as a web address, when known. */
	readonly issues?: string;
	/** The message with these lines taken off. */
	readonly message: string;
}

const IMPORTED = /^git ([0-9a-f]{7,64}), (.+), (\d{4}-\d\d-\d\dT[^,\s]+)$/;
const ISSUES = /^Issues: (https?:\/\/\S+)$/;
const PUSHED = /^Git-Commit: ([0-9a-f]{7,64})$/;
const PUSHED_BY = /^Author: (.+)$/;

/**
 * A push's git origin, from its message's last lines or the commit its host
 * names, or undefined when it didn't come from git. `issues` is where "#N"
 * points when the message doesn't say (the project's "gitIssues").
 */
export function gitOrigin(
	p: { readonly message: string; readonly commit?: string; readonly author?: string },
	issues?: string,
): GitOrigin | undefined {
	const lines = p.message.trimEnd().split("\n");
	let end = lines.length;
	let found: Omit<GitOrigin, "message"> | undefined;
	const tracker = ISSUES.exec(lines[end - 1] ?? "");
	if (tracker) end--;
	const imported = IMPORTED.exec(lines[end - 1] ?? "");
	if (imported) {
		end--;
		found = { commit: imported[1]!, author: imported[2]!, time: imported[3]! };
	} else {
		const by = PUSHED_BY.exec(lines[end - 1] ?? "");
		const sha = PUSHED.exec(lines[end - (by ? 2 : 1)] ?? "");
		if (sha) {
			end -= by ? 2 : 1;
			found = { commit: sha[1]!, ...(by ? { author: by[1]! } : {}) };
		}
	}
	if (!found && p.commit !== undefined) found = { commit: p.commit, ...(p.author ? { author: p.author } : {}) };
	if (!found) return undefined;
	const where = tracker?.[1] ?? issues;
	return {
		...found,
		...(where ? { issues: where.replace(/\/+$/, "") } : {}),
		message: lines.slice(0, end).join("\n").trimEnd(),
	};
}

/** A git remote's issues on the web: GitHub's or GitLab's, by https or ssh; else undefined. */
export function issuesOf(remote: string): string | undefined {
	const plain = remote
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const m = /^(?:https:\/\/|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[:/]([\w.-]+(?:\/[\w.-]+)+)$/.exec(plain);
	if (!m) return undefined;
	return m[1] === "gitlab.com" ? `https://gitlab.com/${m[2]}/-/issues` : `https://github.com/${m[2]}/issues`;
}

/** The issues "#N" names in text, each once, in order: not "owner/repo#N", which names its own. */
export function issueNumbers(text: string): number[] {
	const out: number[] = [];
	for (const m of text.matchAll(/(^|[^\w/])#(\d+)\b/g)) {
		const n = Number(m[2]);
		if (!out.includes(n)) out.push(n);
	}
	return out;
}

/** One line per "#N" in text, saying which tracker it's in. Empty without a tracker or a reference. */
export function issueLinks(text: string, issues: string | undefined): string[] {
	if (!issues) return [];
	return issueNumbers(text).map((n) => `#${n} is ${issues}/${n}`);
}
