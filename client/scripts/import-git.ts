// Import a git repository into a new abso project, with its history (#58;
// first used for #56, abso hosts abso). Each commit on the first-parent line
// of --ref becomes a version of shared, oldest first: the first by `avcs
// init`, each later one by a publish of that commit's tree, with the commit's
// message and a last line naming the commit, its author and its time.
// --last-only imports the last commit alone.
//
// Before anything is created, the last commit is checked: abso stores text
// with LF line endings and a final newline, so a file git holds otherwise
// would come back different, and the imported history would no longer match
// its commits; and the commit's own ignore rules must leave none of its files
// out.
//
// What a first cut leaves for later (#58): every version's agent is the
// importing agent and its time is the import's (the commit's author and time
// are in the message); merges come in as their first parent's line; a run
// that stops partway goes on with --after <sha> in the same --dir.
//
// CI counts each imported version as seen as soon as it lands, so it never
// checks or bisects the history; it checks what is published after the
// import.
//
//   node client/scripts/import-git.ts --project <name> [--ref origin/main]
//     [--server <url>] [--agent import] [--dir <empty folder>]
//     [--last-only] [--check-only] [--after <sha>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { open } from "../src/commands.ts";
import { loadIgnore } from "../src/folder.ts";
import { main } from "../src/main.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		ref: { type: "string", default: "origin/main" },
		server: { type: "string", default: "https://api.abso.dev" },
		agent: { type: "string", default: "import" },
		dir: { type: "string" },
		"last-only": { type: "boolean", default: false },
		"check-only": { type: "boolean", default: false },
		after: { type: "string" },
	},
});
const checkOnly = values["check-only"] === true;
if (!values.project && !checkOnly) fail("give the new project a name with --project <name> (or --check-only)");
if (values.after !== undefined && !values.dir)
	fail("--after goes on in the folder an earlier run used: give it with --dir");

const last = git(["rev-parse", "--verify", `${values.ref}^{commit}`]).trim();
const line = values["last-only"] ? [last] : git(["rev-list", "--reverse", "--first-parent", last]).trim().split("\n");
const after =
	values.after === undefined ? undefined : git(["rev-parse", "--verify", `${values.after}^{commit}`]).trim();
const start = after === undefined ? 0 : line.indexOf(after) + 1;
if (after !== undefined && start === 0) fail(`${values.after} isn't on ${values.ref}'s first-parent line`);

const dir = values.dir ? resolve(values.dir) : mkdtempSync(join(tmpdir(), "avcs-import-"));
mkdirSync(dir, { recursive: true });
if (after === undefined && readdirSync(dir).length > 0) fail(`${dir} isn't empty`);
if (
	after !== undefined &&
	!existsSync(join(dir, ".abso", "config.json")) &&
	!existsSync(join(dir, ".avcs", "config.json"))
)
	fail(`${dir} isn't an abso folder; --after goes on in an earlier run's folder`);

// The last commit first: nothing is created unless it passes.
const check = after === undefined ? dir : mkdtempSync(join(tmpdir(), "avcs-import-check-"));
const files = extract(last, check);
const changed = files.flatMap((rel) => {
	const why = notCanonical(readFileSync(join(check, rel)));
	return why ? [`  ${rel}: ${why}`] : [];
});
const ignore = loadIgnore(check);
const ignored = files.filter((rel) => ignore(rel, false)).map((rel) => `  ${rel}`);
if (check !== dir) rmSync(check, { recursive: true, force: true });
console.log(
	`${values.ref} is ${last.slice(0, 12)}: ${files.length} files, ${line.length} ${line.length === 1 ? "commit" : "commits"} to import${start > 0 ? ` (${line.length - start} after ${after!.slice(0, 12)})` : ""}.`,
);
if (ignored.length > 0)
	fail(
		`Its ignore rules leave out ${ignored.length} of its own files, so the project would lack them:\n${ignored.join("\n")}`,
	);
if (changed.length > 0)
	fail(
		`abso would store ${changed.length} of its files differently from git, so the imported history wouldn't match git. Fix them first:\n${changed.join("\n")}`,
	);
if (checkOnly) {
	console.log("Every text file is as abso will store it. Nothing imported (--check-only).");
	if (after === undefined) rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}

const env = { cwd: dir, env: process.env, write: () => {} };
let skipped = 0;
for (let i = start; i < line.length; i++) {
	const sha = line[i]!;
	extract(sha, dir);
	const message = `${git(["log", "-1", "--format=%B", sha]).trim()}\n\ngit ${sha.slice(0, 12)}, ${git(["log", "-1", "--format=%an, %aI", sha]).trim()}`;
	const subject = message.split("\n")[0]!.slice(0, 72);
	// The first commit makes the project; --as-is adds no starting .absoignore or avcs.json git never had.
	const argv =
		i === 0
			? ["init", dir, "--server", values.server!, "--project", values.project!, "--agent", values.agent!, "--as-is"]
			: ["push", "-m", message];
	let r = await main(argv, env);
	// A lost connection: try again. If the lost publish did land, the next try finds nothing to publish.
	for (
		let tries = 1;
		i > 0 && r.exit !== 0 && /could not reach|answered 5\d\d/.test(r.stdout + r.stderr) && tries < 3;
		tries++
	) {
		await new Promise((ok) => setTimeout(ok, 2000));
		r = await main(argv, env);
	}
	if (r.exit !== 0)
		fail(
			`[${i + 1}/${line.length}] ${sha.slice(0, 12)} ${subject}: ${argv[0]} failed (exit ${r.exit}).\n${r.stdout}${r.stderr}\nGo on from the commit before it with --after ${i === 0 ? "(none: start again in an empty folder)" : line[i - 1]!.slice(0, 12)} --dir ${dir}`,
		);
	const empty = /^Nothing (to push|pushed)/m.test(r.stdout);
	if (empty) skipped++;
	const version = /(?:version|at version) (\d+)/.exec(r.stdout)?.[1];
	if (version !== undefined) await skipCi(Number(version));
	console.log(
		`[${i + 1}/${line.length}] ${sha.slice(0, 12)} ${subject}${empty ? " (no change: no version)" : version ? ` -> version ${version}` : ""}`,
	);
}
console.log(
	`Imported ${values.ref} (${last.slice(0, 12)}) as project ${values.project}: ${line.length - start - skipped} versions${skipped > 0 ? `, ${skipped} commits with no change` : ""}. ${dir} is agent ${values.agent}'s folder; keep it or delete it.`,
);

/** CI: versions through `through` are history, seen already. A server that can't be told is told nothing. */
async function skipCi(through: number): Promise<void> {
	try {
		await open(env).api.ciSkip(through);
	} catch (e) {
		if (through === 0)
			console.log(
				`Note: CI wasn't told to skip the history (${e instanceof Error ? e.message : String(e)}); it may check and bisect old versions once.`,
			);
	}
}

/** The commit's tree in `dir`, replacing everything but .avcs and .abso; its files, folder-relative. */
function extract(sha: string, into: string): string[] {
	for (const e of readdirSync(into))
		if (e !== ".avcs" && e !== ".abso") rmSync(join(into, e), { recursive: true, force: true });
	// Piped, with tar in the folder: no path for tar to misread (GNU tar takes "C:" for a remote host).
	const archive = spawnSync("git", ["archive", "--format=tar", sha], { maxBuffer: 1 << 30 });
	if (archive.status !== 0) fail(`git archive: ${archive.stderr.toString().trim()}`);
	const untar = spawnSync("tar", ["-xf", "-"], { cwd: into, input: archive.stdout, encoding: "utf8" });
	if (untar.status !== 0) fail(`tar couldn't unpack ${sha}: ${untar.stderr}`);
	return walk(into).filter((rel) => !rel.startsWith(".avcs/") && !rel.startsWith(".abso/"));
}

/** Why abso would store these bytes differently from git, or undefined. Binary files (NUL, or not UTF-8) go up byte for byte. */
function notCanonical(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) return undefined;
	if (text.includes("\r")) return "it has a carriage return (abso keeps LF only)";
	if (text !== "" && !text.endsWith("\n")) return "it has no final newline (abso adds one)";
	return undefined;
}

function walk(root: string, sub = ""): string[] {
	return readdirSync(join(root, sub), { withFileTypes: true }).flatMap((e) => {
		const rel = sub === "" ? e.name : `${sub}/${e.name}`;
		return e.isDirectory() ? walk(root, rel) : [rel];
	});
}

function git(args: string[]): string {
	const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
	if (r.status !== 0) fail(`git ${args.join(" ")}: ${r.stderr.trim()}`);
	return r.stdout;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}
