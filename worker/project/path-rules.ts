import { pathKey } from "./pathkey.ts";
import { ProjectError } from "./project-error.ts";

/**
 * Why a path isn't canonical, or undefined when it is (#30). A canonical path
 * is relative, uses forward slashes, and has no empty, "." or ".." segments,
 * no control characters and no drive letter, so one file has one spelling.
 * Otherwise "./harness/x" would slip past a filter on "harness/", and "../x"
 * would escape the folder in every box that unpacks it. A ".git" segment would
 * break the push to Artifacts.
 */
export function pathProblem(path: string): string | undefined {
	if (typeof path !== "string" || path === "") return "a path must be a non-empty string";
	if (/[\x00-\x1f\x7f]/.test(path)) return "a path may not hold control characters or line breaks";
	if (path.includes("\\")) return "a path uses forward slashes, not backslashes";
	if (path.startsWith("/")) return "a path is relative to the project, not absolute";
	if (path.includes(":")) return "a path may not hold a colon (a drive letter, or a Windows stream like file::$DATA)";
	// Every agent's disk must be able to hold it, Windows included, as the client screens (68f7a34).
	if (/[<>"|?*]/.test(path)) return `a path may not hold < > " | ? or *, which Windows can't hold`;
	for (const seg of path.split("/")) {
		if (seg === "") return 'a path may not have empty segments (a leading, doubled or trailing "/")';
		if (seg === "." || seg === "..") return `a path may not have "${seg}" segments`;
		// By pathKey, so every spelling abso treats as one name counts (".GIT", ".gıt").
		if (reservedKey(seg) === GIT_KEY) return "a path may not be under .git";
		if (WINDOWS_DEVICE.test(seg.split(".")[0]!.trimEnd()))
			return `"${seg}" is a Windows device name, which no Windows disk can hold as a file`;
		// Windows drops a trailing dot or space, so ".git." is .git there.
		if (/[. ]$/.test(seg)) return `"${seg}" ends in a dot or a space, which Windows drops`;
		// A Windows short (8.3) name can be another file's second name: GIT~1 is .git (git's CVE-2019-1353).
		if (/^[^.~ ]{1,6}~[0-9]{1,6}(\.[^. ]{1,3})?$/.test(seg))
			return `"${seg}" looks like a Windows short name, which can be another file's second name`;
	}
	return undefined;
}

/** Windows device names, with any extension, as the client refuses them (client/src/safety.ts). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
const GIT_KEY = pathKey(".git");

/**
 * A path part's key for comparing it against reserved names: pathKey, after
 * dropping the characters HFS+ ignores in names, so ".g\u200Cit" is .git
 * there (git's is_hfs_dotgit). Only for this comparison: U+200C and U+200D
 * are ordinary characters in Persian and Indic names.
 */
function reservedKey(seg: string): string {
	return pathKey(seg.replace(/[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g, ""));
}
/** The client's folder: .abso, and .avcs from before the rename (224). */
const SETTINGS_KEYS = new Set([pathKey(".abso"), pathKey(".avcs")]);

/** For writes: the path must be canonical, and not under .abso/ or .avcs/ in any spelling, at any depth. */
export function checkPath(path: string): void {
	const problem = pathProblem(path);
	if (problem) throw new ProjectError("bad-request", `bad file path ${JSON.stringify(path)}: ${problem}`);
	// The client's settings stay in the agent's folder and are never published.
	const settings = path.split("/").find((seg) => SETTINGS_KEYS.has(reservedKey(seg)));
	if (settings !== undefined) {
		const folder = reservedKey(settings) === pathKey(".abso") ? ".abso" : ".avcs";
		throw new ProjectError("bad-request", `${path} is under ${folder}/, which stays in the agent's folder`);
	}
}

/** For reads (history, restore): any path a log may hold, canonical or from before #30. */
export function checkReadPath(path: string): void {
	if (typeof path !== "string" || path === "" || /[\n\r]/.test(path)) {
		throw new ProjectError("bad-request", `bad file path ${JSON.stringify(path)}`);
	}
}
