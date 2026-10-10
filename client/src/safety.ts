// Paths from the server are other agents' work: anyone with a token can
// publish one. Before sync, switch, join or restore touches the disk, every
// path in the answer is screened here, so none can write outside the agent's
// folder, into its .git, .claude or .avcs, onto a Windows device, or through
// a link out of the folder. A refused path is left alone and named.

import { lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { ALWAYS_SKIPPED, isSkippedPart, skippedKey } from "./core.ts";
import type { Mode } from "./modes.ts";

/** A path the client would not touch, and why. */
export interface Refused {
	readonly path: string;
	readonly why: string;
}

/** Windows device names: a file of that name (with any extension) is the device, in any folder. */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

/**
 * A Windows short (8.3) name: up to 8 characters with a ~ and a number, and a
 * short extension. On NTFS it can be another file's second name, so CLAUDE~1/x
 * is written into .claude/x and GIT~1/x into .git/x (git's
 * CVE-2019-1353). Git refuses these with core.protectNTFS; so does avcs.
 */
const SHORT_NAME = /^[^.~ ]{1,6}~[0-9]{1,6}(\.[^. ]{1,3})?$/;

/** Characters Windows can't put in a file name: writing one fails, and a sync would stop partway. */
const WINDOWS_CHARS = /[<>"|?*\x01-\x1f]/;

/** Why Windows can't hold `part` safely, or undefined. Checked on every platform, as git does. */
function windowsPart(part: string): string | undefined {
	const bad = WINDOWS_CHARS.exec(part);
	if (bad)
		return `"${part}" has ${bad[0] < " " ? "a control character" : bad[0]}, which Windows can't put in a file name`;
	if (SHORT_NAME.test(part) && part.split(".")[0]!.length <= 8) {
		return `"${part}" looks like a Windows short name, which can be another file's second name (CLAUDE~1 is .claude, GIT~1 is .git)`;
	}
	return undefined;
}

/**
 * Why a folder-relative path from the server can't be written here, or
 * undefined when it can. The rules hold on every platform, so every agent
 * refuses the same paths.
 */
export function unsafePath(rel: string): string | undefined {
	if (typeof rel !== "string" || rel === "") return "it is empty";
	if (rel.includes("\0")) return "it has a NUL byte";
	if (rel.includes("\\")) return "it has a backslash, which Windows reads as a folder separator";
	if (rel.includes(":")) return "it has a colon (a drive letter, or a Windows stream like file::$DATA)";
	if (rel.startsWith("/")) return "it is absolute";
	for (const part of rel.split("/")) {
		if (part === "") return "it has an empty part (//, or a trailing /)";
		if (part === "." || part === "..") return `it has a "${part}" part`;
		if (/[. ]$/.test(part)) return `"${part}" ends in a dot or a space, which Windows drops`;
		if (DEVICE.test(part.split(".")[0]!.trimEnd())) return `"${part}" is a Windows device name`;
		const windows = windowsPart(part);
		if (windows !== undefined) return windows;
		// The exact names are handled as local files (never written). Another spelling (another case, a long s,
		// a dotless i, a character HFS+ leaves out) can be the same folder on Windows or macOS.
		if (isSkippedPart(part) && !ALWAYS_SKIPPED.has(part))
			return `${JSON.stringify(part)} is ${skippedKey(part)} in another spelling, which stays local`;
	}
	return undefined;
}

/** Why a link at `rel` pointing at `target` can't be made here, or undefined when it can. */
export function unsafeLink(rel: string, target: string): string | undefined {
	if (target === "" || target.includes("\0")) return "its link target is empty";
	if (target.startsWith("/") || target.includes("\\") || target.includes(":"))
		return `it links to ${target}, outside this folder`;
	const to = posix.normalize(posix.join(posix.dirname(rel), target));
	if (to === ".." || to.startsWith("../")) return `it links to ${target}, outside this folder`;
	if (to.split("/").some(isSkippedPart)) return `it links into ${to}, which stays local`;
	// A short name in the target can be .git or .claude on Windows.
	for (const part of to.split("/")) {
		const windows = windowsPart(part);
		if (windows !== undefined) return `its link target goes through ${windows}`;
	}
	return undefined;
}

/** True when a folder on the way to `rel` is a link (or a Windows junction): writing there would land wherever it points. */
export function throughLink(root: string, rel: string): boolean {
	let dir = root;
	for (const part of rel.split("/").slice(0, -1)) {
		dir = join(dir, part);
		try {
			const st = lstatSync(dir);
			if (st.isSymbolicLink()) return true;
			if (!st.isDirectory()) return false;
		} catch {
			return false;
		}
	}
	return false;
}

/** The parts of a sync, switch or restore answer that name paths. */
interface Paths {
	readonly files: Readonly<Record<string, string | null>>;
	readonly blobs?: Readonly<Record<string, string | null>>;
	readonly modes?: Readonly<Record<string, Mode>>;
}

/**
 * The answer with every unsafe path taken out, and the paths taken out. A
 * path refused anywhere (text, blob or mode) is taken out everywhere.
 */
export function screenAnswer<T extends Paths>(root: string, answer: T): { answer: T; refused: Refused[] } {
	const refused = new Map<string, string>();
	const all = new Set([
		...Object.keys(answer.files),
		...Object.keys(answer.blobs ?? {}),
		...Object.keys(answer.modes ?? {}),
	]);
	for (const rel of all) {
		const why =
			unsafePath(rel) ??
			(throughLink(root, rel) ? "a folder on its way is a link, which could point outside this folder" : undefined);
		if (why !== undefined) refused.set(rel, why);
	}
	for (const [rel, m] of Object.entries(answer.modes ?? {})) {
		if (refused.has(rel) || typeof m.link !== "string") continue;
		const why = unsafeLink(rel, m.link);
		if (why !== undefined) refused.set(rel, why);
	}
	if (refused.size === 0) return { answer, refused: [] };
	const keep = <V>(o: Readonly<Record<string, V>> | undefined) =>
		o === undefined ? undefined : Object.fromEntries(Object.entries(o).filter(([rel]) => !refused.has(rel)));
	const screened = {
		...answer,
		files: keep(answer.files)!,
		...(answer.blobs ? { blobs: keep(answer.blobs) } : {}),
		...(answer.modes ? { modes: keep(answer.modes) } : {}),
	};
	return {
		answer: screened,
		refused: [...refused].sort(([a], [b]) => a.localeCompare(b)).map(([path, why]) => ({ path, why })),
	};
}

/** What a sync, switch, join or restore says about the paths it refused. Empty when there are none. */
export function refusedText(refused: readonly Refused[]): string[] {
	if (refused.length === 0) return [];
	return [
		`REFUSED ${refused.length === 1 ? "1 path" : `${refused.length} paths`} from the server, and wrote nothing there (another agent pushed ${refused.length === 1 ? "it" : "them"}; tell whoever runs the project):`,
		...refused.map((r) => `  ${JSON.stringify(r.path)}: ${r.why}`),
	];
}
