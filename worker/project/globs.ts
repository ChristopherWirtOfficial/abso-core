// File patterns for starting notes (#37, Builder 4): a note may name files
// by glob ("tools/*.mjs"), or only in its text ("Add --mute-audio to every
// Chromium launch in tools/*.mjs"). Overlap news matches both.

const GLOB = /[*?]/;

/**
 * Whether `path` matches `pattern`: `*` is any run within one folder, `**`
 * any run across folders, `?` one character. A pattern with no `/` and no
 * glob ("main.ts") matches that file name in any folder.
 */
export function matchesPattern(pattern: string, path: string): boolean {
	if (!GLOB.test(pattern))
		return pattern.includes("/") ? pattern === path : pattern === path || path.endsWith(`/${pattern}`);
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*" && pattern[i + 1] === "*") {
			// "**/" also matches no folder at all.
			if (pattern[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const full = new RegExp(`^${re}$`);
	return full.test(path) || (!pattern.includes("/") && full.test(path.slice(path.lastIndexOf("/") + 1)));
}

/** Whether two patterns can name the same file: the same text, or one matches the other as a path. */
export function patternsMeet(a: string, b: string): boolean {
	return a === b || (!GLOB.test(b) && matchesPattern(a, b)) || (!GLOB.test(a) && matchesPattern(b, a));
}

/**
 * Paths and globs written in a note's text: words with a folder in them
 * ("src/render/keys.ts", "tools/*.mjs"), or a file name with a letter
 * extension ("audio.ts"). Version numbers and "x1.3" are not file names.
 */
export function pathsInText(text: string): string[] {
	const out = new Set<string>();
	for (const raw of text.split(/[\s,;:()'"`]+/)) {
		const word = raw.replace(/[.!?]+$/, "");
		if (word === "" || word.startsWith("-") || /^[a-z]+:\/\//i.test(word)) continue;
		if (
			word.includes("/") &&
			/^[\w.*?\-/]+$/.test(word) &&
			/[A-Za-z*]/.test(word) &&
			!word.startsWith("/") &&
			!word.includes("..")
		)
			out.add(word);
		else if (/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*\.[A-Za-z]{1,6}$/.test(word)) out.add(word);
	}
	return [...out].sort();
}
