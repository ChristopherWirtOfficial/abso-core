// Bodies from a file or stdin (Design Lead, 2026-10-08): Windows PowerShell 5.1
// passes a native command's argument badly, so a multi-line --comment,
// --description or answer reached the server cut to its first line, and nobody
// knew. Any text flag also takes --<flag>-file <path>, and the commands whose
// text is their words (ask, answer, announce) take --file <path>. A path of -
// reads stdin. The file's text arrives whole on any shell.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type FlagSpec, type Parsed, UsageError } from "./args.ts";

/** The text flags a command may take from a file instead. */
const BODY_FLAGS = ["message", "comment", "object", "description", "note"] as const;
/** Commands whose text is their last words: --file gives those words. */
const WORDS_FROM_FILE = new Set(["ask", "answer", "announce"]);

/** The command's flags, plus a -file twin for each text flag it takes, and --file where its words are its text. */
export function withBodyFiles(command: string, spec: FlagSpec): FlagSpec {
	const more: Record<string, "string"> = {};
	for (const f of BODY_FLAGS) if (spec[f] === "string") more[`${f}-file`] = "string";
	if (WORDS_FROM_FILE.has(command)) more.file = "string";
	return { ...spec, ...more };
}

/** The line --help adds for these flags, or none. */
export function bodyFilesHelp(command: string, spec: FlagSpec): string | undefined {
	const flags = BODY_FLAGS.filter((f) => spec[f] === "string").map((f) => `--${f}-file`);
	if (WORDS_FROM_FILE.has(command)) flags.push("--file");
	if (flags.length === 0) return undefined;
	return `${flags.join(", ")} <path> read that text from a file, or stdin with -, so text with several lines arrives whole on any shell (Windows PowerShell 5.1 cuts a quoted argument at its first new line).`;
}

/**
 * Reads each -file flag given into the flag it stands for, and --file into the
 * command's words, after the words before it. One trailing new line is
 * dropped, as a shell's $(cat file) would. An empty text is refused.
 */
export function readBodyFiles(
	command: string,
	args: Parsed,
	cwd: string,
	readStdin: () => string = () => readFileSync(0, "utf8"),
): Parsed {
	let stdinUsed = false;
	const read = (flag: string, path: string): string => {
		let text: string;
		if (path === "-") {
			if (stdinUsed) throw new UsageError("only one of the -file flags can read stdin (-)");
			stdinUsed = true;
			text = readStdin();
		} else {
			try {
				text = readFileSync(resolve(cwd, path), "utf8");
			} catch {
				throw new UsageError(`--${flag} ${path}: no such file to read`);
			}
		}
		// A file saved on Windows has CRLF line endings; the text goes up with LF only, as typed text does
		// (the Issues Worker refuses a carriage return as a character a reader can't see).
		text = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
		if (text.trim() === "") throw new UsageError(`--${flag} ${path}: the text is empty`);
		return text;
	};
	const flags = new Map(args.flags);
	let positionals = [...args.positionals];
	for (const f of BODY_FLAGS) {
		// A lone - as the text is a stdin read meant for the -file flag (abso issue 182): posting "-" helps nobody.
		if (flags.get(f) === "-")
			throw new UsageError(`--${f} - would send just "-"; --${f}-file - reads the text from stdin`);
		const path = flags.get(`${f}-file`);
		if (typeof path !== "string") continue;
		if (flags.has(f)) throw new UsageError(`--${f} or --${f}-file, not both`);
		flags.set(f, read(`${f}-file`, path));
		flags.delete(`${f}-file`);
	}
	const path = flags.get("file");
	if (WORDS_FROM_FILE.has(command) && typeof path === "string") {
		// ask <who> and answer <ask> keep their first word; announce's words are all text.
		const keep = command === "announce" ? 0 : 1;
		if (positionals.length > keep)
			throw new UsageError(`--file gives ${command}'s text, so leave the words off the command line`);
		positionals = [...positionals, read("file", path)];
		flags.delete("file");
	}
	return { ...args, positionals, flags };
}
