// Bodies from a file or stdin (body-files.ts): text with several lines arrives
// whole, whatever shell passed the command (Design Lead, 2026-10-08).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseArgs } from "../src/args.ts";
import { bodyFilesHelp, readBodyFiles, withBodyFiles } from "../src/body-files.ts";

const dir = mkdtempSync(join(tmpdir(), "abso-body-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const BODY = "First line:\n\n- one\n- two\n\nLast line.";
// Written with one Windows line ending inside, which arrives as LF.
writeFileSync(join(dir, "body.md"), `${BODY.replace("- two\n", "- two\r\n")}\r\n`);
writeFileSync(join(dir, "empty.md"), "\n  \n");

const ISSUE = { comment: "string", description: "string", title: "string", drop: "boolean" } as const;
const parse = (command: string, spec: Record<string, "string" | "boolean">, words: string[], stdin?: string) =>
	readBodyFiles(command, parseArgs(command, words, withBodyFiles(command, spec)), dir, () => stdin ?? "");

describe("bodies from a file or stdin", () => {
	it("--comment-file and --description-file read the whole file, dropping one trailing new line", () => {
		const a = parse("issue", ISSUE, ["5", "--comment-file", "body.md"]);
		assert.equal(a.flags.get("comment"), BODY);
		assert.equal(a.flags.has("comment-file"), false);
		assert.deepEqual(a.positionals, ["5"]);
		assert.equal(parse("issue", ISSUE, ["new", "T", "--description-file", "body.md"]).flags.get("description"), BODY);
	});

	it("- reads stdin, once", () => {
		assert.equal(
			parse("issue", ISSUE, ["5", "--comment-file", "-"], "from\nstdin\n").flags.get("comment"),
			"from\nstdin",
		);
		assert.throws(
			() => parse("issue", ISSUE, ["5", "--comment-file", "-", "--description-file", "-"], "x"),
			/only one of the -file flags can read stdin/,
		);
	});

	it("--file gives ask's question, answer's words and announce's text", () => {
		assert.deepEqual(parse("ask", { issue: "string" }, ["alice", "--file", "body.md"]).positionals, ["alice", BODY]);
		assert.deepEqual(parse("answer", { note: "string" }, ["12", "--file", "body.md"]).positionals, ["12", BODY]);
		assert.deepEqual(parse("announce", { to: "string" }, ["--file", "body.md"]).positionals, [BODY]);
		assert.throws(
			() => parse("answer", { note: "string" }, ["12", "words", "--file", "body.md"]),
			/--file gives answer's text, so leave the words off the command line/,
		);
	});

	it("refuses both forms at once, a missing file and an empty one", () => {
		assert.throws(() => parse("issue", ISSUE, ["5", "--comment", "x", "--comment-file", "body.md"]), /not both/);
		assert.throws(() => parse("issue", ISSUE, ["5", "--comment-file", "nope.md"]), /no such file to read/);
		assert.throws(() => parse("issue", ISSUE, ["5", "--comment-file", "empty.md"]), /the text is empty/);
	});

	it("refuses a lone - as the text, pointing at the -file flag (abso issue 182)", () => {
		assert.throws(() => parse("issue", ISSUE, ["5", "--comment", "-"]), /--comment-file - reads the text from stdin/);
		assert.throws(() => parse("issue", ISSUE, ["new", "T", "--description", "-"]), /--description-file -/);
		assert.equal(parse("issue", ISSUE, ["5", "--comment", "- one item"]).flags.get("comment"), "- one item");
	});

	it("adds -file twins only for the text flags a command has, and says so in --help", () => {
		assert.deepEqual(Object.keys(withBodyFiles("issue", ISSUE)).sort(), [
			"comment",
			"comment-file",
			"description",
			"description-file",
			"drop",
			"title",
		]);
		assert.deepEqual(withBodyFiles("status", { short: "boolean" }), { short: "boolean" });
		assert.throws(
			() => parseArgs("status", ["--file", "x"], withBodyFiles("status", { short: "boolean" })),
			/unknown option/,
		);
		assert.match(bodyFilesHelp("issue", ISSUE)!, /^--comment-file, --description-file <path> read that text/);
		assert.match(bodyFilesHelp("answer", { note: "string" })!, /--note-file, --file <path>/);
		assert.equal(bodyFilesHelp("status", { short: "boolean" }), undefined);
	});
});
