// The command table and the dispatcher. main() returns what to print and the
// exit code instead of printing, so tests can call it directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAnnounce, runNews, runStart } from "./announce.ts";
import { ApiError } from "./api.ts";
import { bool, type FlagSpec, type Parsed, parseArgs, str, UsageError } from "./args.ts";
import { bodyFilesHelp, readBodyFiles, withBodyFiles } from "./body-files.ts";
import { boxPublic, boxText, login, logout, readBox } from "./box.ts";
import { runDiff, runFiles, runLog, runRestore, runShow } from "./changes.ts";
import { runCheckIgnore } from "./check-ignore.ts";
import { runCi } from "./ci.ts";
import {
	type Env,
	EXIT,
	type Output,
	runBisect,
	runFetch,
	runFixEol,
	runInit,
	runJoin,
	runLogs,
	runMv,
	runPause,
	runPrep,
	runPublish,
	runReader,
	runRecord,
	runResume,
	runRun,
	runServe,
	runSettle,
	runShot,
	runStatus,
	runSync,
	takeNews,
} from "./commands.ts";
import { configPath, findRoot, installKey, readConfig, readToken } from "./config.ts";
import { TOKEN_SERVERS } from "./core.ts";
import { runDraftSync, runLand, runSwitch } from "./drafts.ts";
import { runExport } from "./export.ts";
import { runBlame, runWhere, runWho, runWhy } from "./history.ts";
import { runAnswer, runAsk, runIssue, runIssues, runSearch, runWaiting } from "./issues.ts";
import { adminToken, issuedPublic, keyList, keyListText, keyNew, keyRevoke } from "./key-admin.ts";
import { runUnqueue } from "./queue.ts";
import { runNote, runNotes, runReview } from "./review.ts";
import { runAmend, runDrop, runFollow, runLabel, runLabels, runPluck } from "./versions.ts";
import { runVisibility } from "./visibility-commands.ts";

interface CommandDef {
	readonly flags: FlagSpec;
	readonly usage: string;
	readonly about: string;
	/** Stop reading options at the first word (for `run <command...>`). */
	readonly rest?: boolean;
	readonly run: (args: Parsed, env: Env) => Promise<Output>;
}

/** The server login, box and logout act on: --server, the folder's, or outside a folder abso.dev's (TOKEN_SERVERS[0]). */
export function boxServer(args: Parsed, env: Pick<Env, "cwd">): string {
	const flag = str(args, "server");
	if (flag) return flag;
	const root = findRoot(env.cwd);
	if (!root) return TOKEN_SERVERS[0]!;
	return (JSON.parse(readFileSync(configPath(root), "utf8")) as { server: string }).server;
}

async function runKeyInstall(args: Parsed, env: Env): Promise<Output> {
	// With --server, the folder is the one named (or here), before it is joined: findRoot
	// could find a parent agent's folder and pin the key there.
	const server = str(args, "server");
	const root = server ? resolve(env.cwd, str(args, "dir") ?? ".") : findRoot(env.cwd);
	if (!root)
		throw new UsageError("abso key install runs inside an agent's folder, or takes --server <url> before abso join");
	const stdin = await new Promise<string>((done, reject) => {
		const chunks: Buffer[] = [];
		process.stdin.on("data", (c) => chunks.push(c as Buffer));
		process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", reject);
	});
	const { id } = installKey(root, stdin, server);
	return { text: `Installed agent key ${id}.`, json: { installed: id } };
}

const COMMANDS: Readonly<Record<string, CommandDef>> = {
	init: {
		flags: { server: "string", project: "string", agent: "string", "as-is": "boolean" },
		usage: "abso init [folder] --server <url> --project <name> --agent <name> [--as-is]",
		about:
			"Create a project on the server from a folder's text files. The folder becomes that agent's folder. It writes a starting .avcsignore, and, when the folder has no avcs.json and package.json gives a check or a build to guess, an avcs.json (setup, check, build and out): what the server's CI runs on each new version of shared. Without one, CI runs what it can guess itself, or nothing. --as-is writes neither: the folder goes up exactly as it is (an import).",
		run: runInit,
	},
	key: {
		flags: {
			server: "string",
			dir: "string",
			project: "string",
			agent: "string",
			expires: "string",
			role: "string",
			print: "boolean",
		},
		usage:
			"abso key install [--server <url> [--dir <folder>]] | abso key new <agent> [--server <url> [--dir <folder>]] [--project <name>] [--expires <Nd>] [--role owner|writer|reader] [--print] | abso key list [--agent <name>] [--project <name>] | abso key revoke <id> [--project <name>]",
		about:
			"install reads {key, id} from stdin into .abso/key. With --server, it writes it into a folder not joined yet, so abso join there signs in with the key. new writes the key into that folder and prints only the id; its role is writer unless --role says otherwise (a reader only reads; a writer writes on its own agent's routes; an owner also skips or revokes CI, resumes the queue, syncs git and exports); --print writes the key to stdout instead. list and revoke never print a key. These three read the admin token from AVCS_ADMIN_TOKEN or ~/.abso/admin-token and send it only to a server named in AVCS_ADMIN_SERVERS. An agent does not run them unless a person on the project says so.",
		run: async (args, env) => {
			const sub = args.positionals[0];
			if (sub === "install" && args.positionals.length === 1) return runKeyInstall(args, env);
			const serverFlag = str(args, "server");
			const root = serverFlag ? resolve(env.cwd, str(args, "dir") ?? ".") : findRoot(env.cwd);
			if (!root) throw new UsageError("abso key runs inside an agent's folder, or takes --server <url>");
			let config: ReturnType<typeof readConfig>;
			try {
				config = readConfig(root, env.env);
			} catch {
				config = {
					server: serverFlag ?? "",
					project: str(args, "project") ?? "",
					agent: "admin",
					token: readToken(env.env),
				};
			}
			if (serverFlag) config = { ...config, server: serverFlag };
			const admin = adminToken(env.env);
			if (sub === "new" && args.positionals.length === 2) {
				const server = str(args, "server") ?? config.server;
				const project = str(args, "project") ?? config.project;
				const expires = str(args, "expires");
				const role = str(args, "role");
				if (role !== undefined && role !== "owner" && role !== "writer" && role !== "reader")
					throw new UsageError("--role is owner, writer or reader");
				const issued = await keyNew({ ...config, server }, admin, args.positionals[1]!, project, expires, role);
				const print = bool(args, "print");
				const shown = issuedPublic(issued, print);
				if (!print) {
					const dir = str(args, "server") ? resolve(env.cwd, str(args, "dir") ?? ".") : root;
					installKey(dir, JSON.stringify({ key: issued.key, id: issued.id }), server);
				}
				return {
					text: print ? `${JSON.stringify({ key: issued.key, id: issued.id })}\n` : `Made ${issued.id}.\n`,
					json: shown,
				};
			}
			if (sub === "list" && args.positionals.length === 1) {
				const agent = str(args, "agent");
				const project = str(args, "project") ?? config.project;
				const keys = await keyList({ ...config, server: str(args, "server") ?? config.server }, admin, agent, project);
				return { text: `${keyListText(keys)}\n`, json: { keys } };
			}
			if (sub === "revoke" && args.positionals.length === 2) {
				const project = str(args, "project") ?? config.project;
				const id = args.positionals[1]!;
				const revoked = await keyRevoke(
					{ ...config, server: str(args, "server") ?? config.server },
					admin,
					id,
					project,
				);
				return { text: revoked ? `Revoked ${id}.\n` : `No key ${id}.\n`, json: { id, revoked } };
			}
			throw new UsageError("abso key install | abso key new <agent> | abso key list | abso key revoke <id>");
		},
	},
	login: {
		flags: { server: "string" },
		usage: "abso login [--server <url>]",
		about:
			"Sign this box in once (abso issue 108): it shows a code and a link, and waits while a person approves the code on the website, choosing the projects, the highest role and how many agents. Then abso join in any of those projects gives each agent its own key, with no approval. The box's sign-in is kept in your user folder, never in a project folder, and is never printed. Without --server, the folder's server, or https://api.abso.dev outside a folder.",
		run: async (args, env) => {
			const server = boxServer(args, env);
			const record = await login(server, { say: (line) => process.stderr.write(`${line}\n`) });
			return {
				text: `This box is signed in. ${boxText(record, server).split("\n").slice(1).join(" ")}`,
				json: { box: boxPublic(record) },
			};
		},
	},
	box: {
		flags: { server: "string" },
		usage: "abso box [--server <url>]",
		about:
			"What this box's sign-in allows: its projects, the highest role its agents may have, how many agents it has made and may make, and when it expires. Never the credential.",
		run: async (args, env) => {
			const server = boxServer(args, env);
			const record = readBox(server);
			return { text: boxText(record, server), json: { box: boxPublic(record) } };
		},
	},
	logout: {
		flags: { server: "string" },
		usage: "abso logout [--server <url>]",
		about:
			"End this box's sign-in on the server and forget it here. Keys its agents already have stop working with it.",
		run: async (args, env) => {
			const server = boxServer(args, env);
			const record = readBox(server);
			if (!record) return { text: `This box isn't signed in to ${server}.`, json: { loggedOut: false } };
			const ended = await logout(record);
			return {
				text: ended
					? `Signed this box out of ${record.server}.`
					: `Forgot this box's sign-in here, but ${record.server} couldn't be reached to end it. Revoke the box on the website.`,
				json: { loggedOut: true, ended },
			};
		},
	},
	join: {
		flags: { server: "string", agent: "string", dir: "string", reader: "boolean" },
		usage: "abso join <project> --agent <name> --server <url> [--dir <folder>] [--reader]",
		about:
			"Join a project as a new agent and write its shared files into the folder (default: here). --reader joins as a reader: it reads everything and records nothing, and the server refuses its edits, records and publishes.",
		run: runJoin,
	},
	record: {
		flags: { all: "boolean", binary: "string" },
		usage: "abso record [--all]",
		about:
			"Send every file that changed since the server last heard about it (--all: every file). For edits the hook did not see.",
		run: runRecord,
	},
	publish: {
		flags: {
			message: "string",
			binary: "string",
			"as-is": "boolean",
			check: "optional",
			box: "string",
			wait: "string",
			"no-wait": "boolean",
			done: "boolean",
		},
		usage: 'abso publish -m "<why>" [--as-is] [--check ["<command>"]] [--wait <seconds> | --no-wait] [--done]',
		about:
			'Record, then add your draft to shared. Refused when it collides with work published since your last sync, or when lines a sync showed changed on both sides are still untouched (--as-is publishes both sides\' lines anyway). --check "<command>" (e.g. --check "npm run typecheck") first syncs, then runs the command in your box on your draft with newest shared, and publishes only if it exits 0, so two changes that each pass alone can\'t turn shared red. --check alone runs the "build" and then the "check" in the project\'s avcs.json (your draft\'s copy), as the server does on each new version. With the merge queue on ("queue": true in avcs.json), a publish to shared is queued and lands only once the project\'s check passes on shared with it on top: publish waits up to 100 s for that (--wait <seconds> changes it, --no-wait returns at once), then says it landed (exit 0), was pulled with the check\'s output (exit 2, its changes still in your draft), or is still queued (exit 3; the outcome comes as news). --check alone is skipped then, since the queue runs the check. --done takes your start note back once it\'s published: this publish finishes that work.',
		run: runPublish,
	},
	bisect: {
		flags: { good: "string", bad: "string", box: "string" },
		usage: "abso bisect [--good <version>] [--bad <version>] -- <program> <arg...>",
		about:
			"The first version where a check fails: runs it in your box at versions of your folder's space (as abso run --at does) and prints that version, its author and message. --bad is the newest by default; without --good it steps back in doubling steps until one passes, then halves the gap. A run that exits 0 passes; exit 125 means it can't be tested (as in git bisect run), so that version is skipped, and if skips leave the answer open it names the range. About log2(versions) runs; your folder is never touched.",
		rest: true,
		run: runBisect,
	},
	reader: {
		flags: {},
		usage: "abso reader on|off",
		about:
			"Make this folder's agent a reader, which reads everything and records nothing (the server refuses its edits, records and publishes), or a writer again. Refused while it has unpublished or parked work.",
		run: runReader,
	},
	settle: {
		flags: { yours: "boolean", theirs: "boolean", both: "boolean" },
		usage: "abso settle <file...> --yours|--theirs|--both",
		about:
			"Settle the collisions a sync marked in these files: each marker block becomes your lines, theirs, or both (yours first), then it records. abso status lists the files with markers.",
		run: runSettle,
	},
	sync: {
		flags: { verbose: "boolean", full: "boolean" },
		usage: "abso sync [--full]",
		about:
			"Record, then bring shared's new work into the folder. Lines changed on both sides are listed as collisions to settle. --full writes any file of yours the folder is missing, not only what changed since your last sync.",
		run: runSync,
	},
	run: {
		flags: {
			detach: "boolean",
			replace: "boolean",
			fresh: "boolean",
			parallel: "boolean",
			at: "string",
			files: "string",
			fetch: "string",
			box: "string",
			with: "string",
			quiet: "boolean",
		},
		usage:
			'abso run [--detach] [--replace] [--fresh] [--box <name>] [--at <version> [--files <glob>]] <command...> | abso run ... -- <program> <arg...> | abso run --parallel "<command>" "<command>"...',
		about:
			"Send the folder to this agent's box, run the command there, and stream its output back. Exits with the command's code. After --, each word goes to the program exactly as typed (quotes, backslashes, regex text); without --, the words are one shell command. The box's stderr comes out on stderr. --detach starts it and prints its id without waiting. While a run is still going in the box, a new one is refused (409, naming it), since it would replace the files under it; --replace stops the old one first. --parallel runs each quoted command at once in the box (one upload), labels each line [1], [2], ..., ends with each one's exit code, and exits with the worst. --at <version> runs that version of the folder's space instead of the folder (for bisecting); with --files <glob>, only the matching files are taken from that version. The folder is never touched. --fetch <glob>[,<glob>...] brings matching files from the box's /w back after the run (see abso fetch); several globs go in one argument, comma-separated (--fetch 'shots/*.png,out/*.json'), as for --files and --with. The box's /w is replaced by your folder on every run; the rest of the box (/tmp, ~/.cache, /w/node_modules) lasts between runs until the box stops (idle 30 minutes, or restarted). abso's own notices go to stderr, apart from the command's output; --quiet drops them (the command's own stderr still comes through). --with <box path>=<local path>[,...] adds files (or a folder's files) for this run only: they go to the box and are never written to your folder or recorded, for an A/B run that leaves the project alone. --box <name> (or AVCS_BOX=<name>) runs in another box of yours, with its own /w and state, so a subagent's runs and yours don't wait on each other; logs and fetch take --box too. After abso prep, a fresh box starts from the prep; --fresh starts this run from the plain image instead.",
		rest: true,
		run: runRun,
	},
	serve: {
		flags: { version: "string", build: "string", out: "string" },
		usage: 'abso serve [--version <n>] [--build "<command>"] [--out <folder>]',
		about:
			"A preview of one version of shared (the newest by default) at a stable URL that needs no token, for playing a fixed build in a browser with no local server and no sound on this machine. The server builds it once per version (npm ci, then vite build --base ./ into dist; --build and --out change that) and keeps the newest 10 builds. Asking again for a built version answers at once.",
		run: runServe,
	},
	mv: {
		flags: {},
		usage: "abso mv <from> <to>",
		about:
			"Move a file in your draft, its lines keeping their history (as git mv), recorded as a move rather than guessed from the folder. The way to change a file's case: README.md and readme.md are one file in abso, and a write under another spelling goes to the existing one, with a warning that names abso mv. It reaches shared with your next publish.",
		run: runMv,
	},
	review: {
		flags: { since: "string" },
		usage: "abso review [<id> | v<version> | <agent>] [--since <position|2h>]",
		about:
			"Review is reading what landed (#44). With no change: the changes with anything new since you last looked, newest first (a change is one start note's work, a named draft's, or a lone publish), and the mark moves on; --since 2h (or a log position) looks further back without moving it. With a change id, v<version> (the change holding that version of shared) or an agent (its newest change): that change's page, with what it set out to do, its versions, what it settled, its reviewers and its notes.",
		run: runReview,
	},
	note: {
		flags: {
			object: "boolean",
			read: "boolean",
			draft: "string",
			at: "string",
			reply: "string",
			close: "string",
			resolved: "boolean",
			withdrawn: "boolean",
		},
		usage:
			'abso note <file>:<line>[-<line>] "<text>" [--object | --read] [--draft <agent> | --at <version>] | abso note --reply <id> "<text>" | abso note --close <id> --resolved|--withdrawn',
		about:
			"A note on lines (#44): it sits on those lines and follows them as the file changes. The lines' authors and the change's agent hear it as news. The line numbers are as your folder shows the file (it records first); --draft <agent> notes their unpublished work as their draft shows it, --at <version> a version of shared. --object asks for a fix (it shows as addressed once all its lines change); --read says you read it, telling nobody. --reply answers a note; --close closes one of yours.",
		run: runNote,
	},
	notes: {
		flags: { change: "string", all: "boolean" },
		usage: "abso notes [file] [--change <id>] [--all]",
		about:
			"The open notes, on a file or a change, with their replies and where their lines are now. --all includes closed, addressed and outdated ones.",
		run: runNotes,
	},
	issues: {
		flags: {
			open: "boolean",
			status: "string",
			agent: "string",
			parent: "string",
			label: "string",
			labels: "boolean",
			drafts: "boolean",
		},
		usage:
			"abso issues [--open] [--status <status>] [--agent <agent>] [--parent <N>] [--label <l,l>] | abso issues --labels",
		about:
			"The project's issues (#54), most recently updated first, each with its status, agents, labels, versions and who it waits on. --label keeps the issues with every label named (friction, say); --labels lists the labels in use, with how many issues are open under each; --drafts lists your drafts. A status comes from the work: abso start --issue N puts an issue In progress, an open ask makes it Blocked (or In review, for a review), and publish --done closes it.",
		run: runIssues,
	},
	issue: {
		flags: {
			comment: "string",
			object: "string",
			drop: "boolean",
			reopen: "boolean",
			done: "boolean",
			"done-by": "string",
			title: "string",
			description: "string",
			parent: "string",
			lines: "string",
			agent: "string",
			"blocked-by": "string",
			notify: "string",
			quiet: "boolean",
			label: "string",
			unlabel: "string",
			open: "boolean",
			delete: "boolean",
			attach: "string",
		},
		usage:
			'abso issue <N> [--comment "..." [--attach <file,file>] | --object "..." | --drop | --reopen | --done [--done-by <version>]] | abso issue <N> [--title "..."] [--description "..."] [--parent <N|none>] [--agent <agent|none>] [--blocked-by <N,N|none>] [--label <l,l>] [--unlabel <l,l>] [--notify <who,who> | --quiet] | abso issue new "<title>" [--description "..."] [--parent <N>] [--lines <file>:<from>-<to>@<version>] [--agent <agent>] [--blocked-by <N,N>] [--notify <who,who>] [--label <l,l>] [--attach <file,file>]',
		about:
			"One issue: its description, Agent, Blocked by, labels, asks, comments, edits, sub-issues and watchers. --comment comments on it and --object objects; its agents hear either. --drop drops it. --reopen opens a dropped issue again. --done marks it done by hand, and --done-by <version> names the published version that did it. publish --done still marks it done too. --title, --description, --parent, --agent and --blocked-by edit it, and the edit tells its watchers (who opened it, its Agent and agents, its Reviewer, whoever was named in Notify, and whoever commented); --notify tells more people, --quiet tells nobody. --label adds labels and --unlabel takes them off (friction, area:client: lower-case letters, digits and - _ . :); a label-only edit tells nobody unless --notify names people. An issue is Blocked until each issue it's blocked by is Done. abso issue new opens one; --lines ties it to lines at a version of shared, --agent says who it's for, --notify tells people now, and --label labels it. --attach shot.png,after.png puts images on a new issue or a comment (png, jpeg, gif or webp, 10 MB each; the server checks the type by the bytes and takes out metadata such as where a photo was taken), and prints each one's id for the text to point at; the issue's page lists them with a link. abso issue draft \"<title>\" [the same fields] saves a draft instead: yours alone, with no number and no news; abso issue draft <D> [fields] changes it, --open opens it as an issue, --delete deletes it.",
		run: runIssue,
	},
	ask: {
		flags: {
			issue: "string",
			review: "boolean",
			task: "boolean",
			due: "string",
			blocks: "string",
			options: "string",
			withdraw: "string",
			note: "string",
		},
		usage:
			'abso ask <who> "<question>" [--issue <N>] [--review | --task] [--due <YYYY-MM-DD>] [--blocks <N,N>] [--options "A|B|C"] | abso ask --withdraw <ask> [--note "why"]',
		about:
			"Ask an agent, or a person (person:<id>), something; they hear it. On an issue, it holds the issue at Blocked (In review for --review) until answered. --task asks for something done instead of an answer; --options gives the choices; --blocks names the issues waiting on it. --withdraw takes back an ask you made that no longer needs an answer: it leaves their waiting list, stops holding the issue, keeps your --note as why, and they hear it.",
		run: runAsk,
	},
	search: {
		flags: { limit: "string" },
		usage: 'abso search "<words>" [--limit <N>]',
		about:
			"The project's issues that match, best first: by their words, and by what they mean where the server has meaning search on, so an issue worded differently from your search still turns up. #N or N puts issue N first. Each hit says where it matched; one only meaning search found says by meaning.",
		run: runSearch,
	},
	waiting: {
		flags: { of: "string", mine: "boolean" },
		usage: "abso waiting [--of <agent or person:id>] [--mine]",
		about: "The open asks, soonest due first: every one, those of someone (--of), or those of you (--mine).",
		run: runWaiting,
	},
	answer: {
		flags: { option: "string", note: "string", done: "boolean" },
		usage:
			'abso answer <ask> "<words>" | abso answer <ask> --option <N> [--note "..."] | abso answer <ask> --done [--note "..."]',
		about:
			"Answer an ask of you, in your own words, by picking an option (by number or text), or, for a task, with --done. The asker hears it.",
		run: runAnswer,
	},
	unqueue: {
		flags: {},
		usage: "abso unqueue",
		about:
			"Take back your publishes still waiting in the merge queue: their changes stay in your draft, unpublished. Refused while one is being checked; it lands or is pulled within a few minutes (abso drop takes it back after it lands).",
		run: runUnqueue,
	},
	visibility: {
		flags: { yes: "boolean" },
		usage: "abso visibility [public|private] [--yes]",
		about:
			"Whether the project is public (abso issue 152). With no word, says which. public, with --yes, lets anyone read it, signed in or not: files, versions, drafts, notes, Issues, people's names, CI as pass or fail; never keys, CI logs, preview links or boxes. private makes it members-only again. Switching takes the project owner's key (on staging, the shared token works too).",
		run: runVisibility,
	},
	ci: {
		flags: { version: "string", revoke: "boolean" },
		usage: "abso ci [<version>] | abso ci --revoke",
		about:
			"The project's CI: the server runs avcs.json's setup, build and check on each new version of shared, one job at a time on the newest. abso ci says whether shared is green or red (and since which version, by whom, once a bisect finds it), what is being checked, and the preview link of the newest passing build, which needs no token. abso ci <version> shows that version's job: which step failed, its exit code, and the end of its output. status says the same in a line, and log marks each version of shared. --revoke ends every preview link handed out so far and makes a new one.",
		run: runCi,
	},
	shot: {
		flags: {
			out: "string",
			wait: "string",
			size: "string",
			box: "string",
			eval: "string",
			click: "string",
			mouse: "string",
			at: "string",
			scale: "string",
			region: "string",
			text: "boolean",
			tree: "boolean",
			interactive: "boolean",
			depth: "string",
			find: "string",
			"max-chars": "string",
			image: "boolean",
		},
		usage:
			'abso shot ["/<path>?<query>"] [--scale 0.1-1] [--region x0,y0,x1,y1] [--text] [--tree [--interactive] [--depth N]] [--find "<text>"] [--max-chars N] [--image] [--at <version>] [--eval "<js>"] [--click "x,y[@ms];ref_N[@ms]"] [--mouse x,y|ref_N] [--out <file.png>] [--wait <ms>] [--size <w>x<h>]',
		about:
			"A look at your folder's game, taken in your box: it runs the project's vite dev server and Playwright on that page (default /, a 1280x720 page). Images cost tokens, so read without one when you can: --text prints the page's visible text, --tree its elements (role, name, a ref like ref_12, and its box in page pixels; --interactive only what can be clicked or typed in; --depth N levels), and --find \"<text>\" the elements matching some text; each is capped at --max-chars (default 5000). With none of those, or with --image, it writes a PNG to .avcs/shots/ (never recorded) or --out, and prints its pixel size and about how many tokens reading it costs (width x height / 750). --scale 0.5 halves the width and height (a quarter of the tokens); --region x0,y0,x1,y1 takes part of the page at full detail; they combine. Coordinates are always the page's, whatever the scale or region. To set up a state first, --eval runs JavaScript in the page and --click clicks points (x,y or ref_N; several separated by ;; @ms waits first), in that order, a second after load and two frames after the eval; --mouse x,y or ref_N leaves the pointer there (for hover cards); then it waits --wait ms (default 3000) and looks. It prints --eval's result, page errors and the first 30 console messages. Refs come from --tree or --find on the same page in the same state. --at <version> looks at that version of your folder's space instead of the folder (as abso run --at). Needs vite and playwright in the project's devDependencies; abso prep with npx --no-install playwright install chromium makes it fast.",
		run: runShot,
	},
	prep: {
		flags: { forget: "boolean", box: "string" },
		usage: 'abso prep [--box <name>] "<setup command>" | abso prep --forget',
		about:
			"Set up your box once and keep it: sends the folder, runs the setup command (npm ci, npx playwright install chromium, a build) in a fresh box of the current image, and saves the box. From then on every fresh box (after a deploy, 30 idle minutes, or a new run's restart) starts from it, with node_modules, ~/.cache and /tmp as the setup left them; /w is still replaced by your folder on each run, apart from node_modules. abso run says when the prep is set aside (a newer box image) or out of date (package-lock.json changed): run abso prep again then. --forget drops it.",
		rest: true,
		run: runPrep,
	},
	fetch: {
		flags: { box: "string" },
		usage: "abso fetch [--box <name>] <glob...>",
		about:
			"Files the last run left in the box's /w (bash globs: out/*.png, **/*.log), written into the folder, but only where abso ignores them, so a fetched file never becomes an edit; the rest are named and left alone. /w is replaced on the next run, and everything goes when the box stops.",
		run: runFetch,
	},
	pause: {
		flags: {},
		usage: "abso pause",
		about:
			"Send nothing from this folder until abso resume: the edit hook skips, abso record refuses, other commands don't record first. For swapping files in by hand (abso run --at usually does it better).",
		run: runPause,
	},
	resume: {
		flags: {},
		usage: "abso resume",
		about: "End abso pause. Changes made while paused go at the next record.",
		run: runResume,
	},
	logs: {
		flags: { box: "string" },
		usage: "abso logs [--box <name>] <run id>",
		about:
			"A run's output from its start (stdout and stderr apart), for as long as the box keeps it, waiting until it ends. Exits with its code. For abso run --detach, or a run whose connection was lost.",
		run: runLogs,
	},
	status: {
		flags: { short: "boolean" },
		usage: "abso status [--short]",
		about:
			"The shared version, whether shared is green or red by the project's CI (abso ci has more), who waits in the merge queue, every agent's base and draft, and what in this folder is not yet recorded. --short prints one word for stamping a build: the version this folder is on (214), with the named draft (coast@3), +unpublished when it holds changes not yet published, and +queued when a publish of yours waits in the merge queue.",
		run: runStatus,
	},
	switch: {
		flags: { carry: "boolean", verbose: "boolean" },
		usage: "abso switch <draft> | abso switch -c <new draft> | abso switch shared",
		about:
			"Move this folder to a named draft, or back to shared. Your unpublished changes are parked where you leave and come back when you return; -c carries them into a new draft instead.",
		run: runSwitch,
	},
	land: {
		flags: { message: "string" },
		usage: 'abso land -m "<why>"',
		about:
			"Land your named draft in shared, as one unit. Refused only on a collision with work that landed in shared since the draft began.",
		run: runLand,
	},
	"draft-sync": {
		flags: {},
		usage: "abso draft-sync",
		about: "Move your named draft onto shared's newest version, then bring that into this folder.",
		run: runDraftSync,
	},
	diff: {
		flags: { draft: "string" },
		usage: "abso diff [file...] | abso diff <from> <to> [file...] [--draft <name>]",
		about:
			"Your unpublished changes, line by line, as git prints them (records first). With two versions: what changed between them in this space.",
		run: runDiff,
	},
	restore: {
		flags: { all: "boolean" },
		usage: "abso restore <file...> | abso restore <file>:<line>[-<line>] | abso restore --all",
		about:
			"Discard your unpublished changes to those files (--all: to every file), like git restore. The files go back to how your space has them. <file>:<lines> puts back only the changes that touch those lines (numbered as abso diff shows the file now) and keeps your other changes to it.",
		run: runRestore,
	},
	export: {
		flags: { version: "string", keep: "string" },
		usage: "abso export <dir> [--version <N>] [--keep <glob>]",
		about:
			"Write one published version of this folder's space (the newest unless --version) into a folder of its own, for a build that doesn't move. The folder must be empty, an earlier export (which it replaces, keeping node_modules and what --keep names), or one .avcsignore leaves out; .avcs-export.json there names the version.",
		run: runExport,
	},
	files: {
		flags: { draft: "string", version: "string" },
		usage: "abso files [glob...] [--draft <name>] [--version <N>]",
		about:
			"The files your folder should hold (your view), marking any it's missing. With --draft or --version: that space's files at that version (--draft shared for shared).",
		run: runFiles,
	},
	log: {
		flags: { limit: "string", draft: "string", since: "string", by: "string", count: "boolean" },
		usage:
			"abso log [file] [-n <count>] [--draft <name>] [--since <version|30m|2h|1d|date>] [--by <agent,...>] [--count]",
		about:
			"The published versions of this folder's space (shared or a named draft), newest first: who, when, why and which files, and for shared, whether the version passed CI's check (abso ci). With a file: only the versions that changed it. --since takes a version (the versions after it), a span back from now (30m, 2h, 1d), a clock time today (20:00) or a date and time; --by keeps one agent's versions (or several, comma-separated); --count prints versions and files per agent instead of the list.",
		run: runLog,
	},
	show: {
		flags: { draft: "string" },
		usage: "abso show <version> | abso show <version>:<file> [--draft <name>]",
		about: "One version: who published it, why, and its diff. With :<file>, that file's text as it was then.",
		run: runShow,
	},
	announce: {
		flags: { to: "string" },
		usage: "abso announce [--to <agent,agent>] <text>",
		about:
			"Tell the project's other agents (or those named) something. Each gets it once, as news on their next edit or the mod's next check.",
		run: runAnnounce,
	},
	start: {
		flags: { done: "boolean", issue: "string" },
		usage: 'abso start "<what>" [files...] [--issue <n>] | abso start --done',
		about:
			"Say what you are starting on, before your first edit, so abso where shows it to everyone. Names who already has unpublished changes in those files, and tells them. Nothing is locked; publishing ends the note.",
		run: runStart,
	},
	news: {
		flags: {},
		usage: "abso news",
		about:
			"The news waiting for you: collisions, changed definitions, moved lines and announcements. Each item comes once.",
		run: runNews,
	},
	"fix-eol": {
		flags: {},
		usage: "abso fix-eol",
		about:
			"Rewrite the files that differ from what abso recorded only in line endings (CRLF here) with LF, as recorded. Their text is unchanged, so nothing is recorded; abso status stops listing them.",
		run: runFixEol,
	},
	who: {
		flags: {},
		usage: "abso who <file...>",
		about:
			"For each file: who last changed it, who has unpublished changes in it (and where), and whose abso start note names it. Ask before you start in someone's file.",
		run: runWho,
	},
	where: {
		flags: {},
		usage: "abso where",
		about: "Who is working where: each file with unpublished changes, whose they are, and which lines.",
		run: runWhere,
	},
	blame: {
		flags: { from: "string", to: "string", version: "string", draft: "string", mine: "boolean" },
		usage: "abso blame <file> [--from <n>] [--to <n>] [--version <n>] [--draft <name> | --mine]",
		about:
			"Who wrote each line of the file as shared has it (or had it at --version), and the publish that brought it in. --draft reads a named draft; --mine reads your own view, marking your unpublished lines with *.",
		run: runBlame,
	},
	why: {
		flags: { draft: "string", mine: "boolean" },
		usage: "abso why <file>:<line> [--draft <name> | --mine]",
		about:
			"Why one line of shared (or of a named draft, or your own view) is the way it is: its change, its publish, its reasons, and any collision it settled.",
		run: runWhy,
	},
	drop: {
		flags: { message: "string", "with-dependents": "boolean" },
		usage: 'abso drop <version...> -m "<why>" [--with-dependents]',
		about:
			"Take published versions back out of shared, as a new version: like git revert. History keeps them. Refused when later versions build on them, unless --with-dependents drops those too.",
		run: runDrop,
	},
	pluck: {
		flags: { message: "string", "with-dependencies": "boolean" },
		usage: 'abso pluck <draft> <version...> -m "<why>" [--with-dependencies]',
		about:
			"Take some versions of a named draft into shared, as one version, leaving the draft as it is: like git cherry-pick. Refused when they build on other versions of the draft, unless --with-dependencies takes those too.",
		run: runPluck,
	},
	amend: {
		flags: { message: "string" },
		usage: 'abso amend -m "<new message>"',
		about:
			"Correct the message of your newest publish in this space. Only the message changes; the log keeps the original.",
		run: runAmend,
	},
	label: {
		flags: { version: "string", remove: "boolean" },
		usage: "abso label <name> [--version <n>] [--remove]",
		about:
			"Put a label on a version of shared (the newest by default), or take it off: like a git tag. A label can mark more than one version.",
		run: runLabel,
	},
	labels: {
		flags: {},
		usage: "abso labels",
		about: "Every label and the versions it marks.",
		run: runLabels,
	},
	follow: {
		flags: { none: "boolean" },
		usage: "abso follow <label> | abso follow --none",
		about:
			"Make this folder follow a label: every sync takes it to the newest version of shared with that label, not the newest version. --none goes back to following shared.",
		run: runFollow,
	},
	"check-ignore": {
		flags: {},
		usage: "abso check-ignore <path...>",
		about:
			"Whether abso leaves each path out, and which line of which ignore file decided (git's rules, for .gitignore and .avcsignore).",
		run: runCheckIgnore,
	},
	pipeline: {
		flags: { on: "string", space: "string", pipeline: "string", every: "string" },
		usage:
			"abso pipeline check [file] [--on publish|draft|green|land|hand|schedule [--space <name>] [--pipeline <name>] [--every <when>]]",
		about:
			"Read the folder's pipeline file (abso.yml, abso.yaml or avcs.json, or the file named) and say what's wrong with it, place by place: a cycle in needs, a job that doesn't exist, secrets a draft could reach, a key it doesn't know. Exits 1 when it has problems. With --on, it says which pipelines that event starts (in shared, or --space), with their jobs in waves that can run side by side, and why each other pipeline doesn't start. It reads only the file.",
		// Loaded only here, so the yaml package it needs can't stop every other command
		// when a checkout lacks it (abso issue 168).
		run: async (args, env) => {
			let mod: typeof import("./pipeline-commands.ts");
			try {
				mod = await import("./pipeline-commands.ts");
			} catch (e) {
				if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND")
					throw new UsageError(
						`abso pipeline needs a package this copy of abso doesn't have installed (${(e as Error).message.split("\n")[0]}); run npm install where abso is installed`,
					);
				throw e;
			}
			return mod.runPipeline(args, env);
		},
	},
};

function help(): string {
	return [
		"abso: version control for agents. This is its command-line client.",
		"",
		...Object.values(COMMANDS).flatMap((c) => [`  ${c.usage}`, `      ${c.about}`]),
		"  abso hook",
		"      The Claude Code PostToolUse hook. Reads the hook JSON on stdin; never fails.",
		"  abso mcp",
		"      An MCP server on stdin and stdout: the reading commands and the everyday writing ones as tools, answering with the same text as here. Add it with claude mcp add abso -- node <repo>/client/abso.ts mcp.",
		"  abso --version",
		"      This client's version and commit, and the abso mods installed on this machine.",
		"",
		"Every command takes --json. Settings live in .abso/config.json (.avcs/config.json in a folder from before the rename). The token comes from AVCS_TOKEN, or else ~/.abso/token (or ~/.avcs/token from before).",
	].join("\n");
}

export interface MainResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exit: number;
	/** What --json prints, whether or not it was asked for (abso mcp answers with both). */
	readonly data?: Record<string, unknown>;
}

/** The commands, for abso mcp: each tool is one of them. */
export function commandTable(): Readonly<
	Record<string, { readonly flags: FlagSpec; readonly usage: string; readonly about: string }>
> {
	return COMMANDS;
}

function newsBlock(news: readonly string[]): string[] {
	return news.length === 0 ? [] : ["News:", ...news.map((n) => `  ${n}`)];
}

export async function main(argv: readonly string[], env: Env): Promise<MainResult> {
	const command = argv[0];
	const json = argv.includes("--json") && command !== "run" && command !== "logs";
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		return { stdout: `${help()}\n`, stderr: "", exit: EXIT.ok };
	}
	try {
		if (command === "--version") {
			// Loaded only here: it runs git, and no other command needs it.
			const { versionReport } = await import("./install.ts");
			const { newerCommitNote } = await import("./client-version.ts");
			const report = versionReport(env.env);
			const root = findRoot(env.cwd);
			let behind: string | undefined;
			if (root) {
				try {
					const server = (JSON.parse(readFileSync(configPath(root), "utf8")) as { server?: string }).server;
					if (server) behind = await newerCommitNote(server);
				} catch {}
			}
			return {
				stdout: json
					? `${JSON.stringify({ ok: true, command: "version", ...report.json, ...(behind ? { serverBehind: behind } : {}) }, null, 2)}\n`
					: `${report.text}${behind ? `\n${behind}` : ""}\n`,
				stderr: "",
				exit: EXIT.ok,
			};
		}
		const def = COMMANDS[command];
		if (!def)
			throw new UsageError(
				`unknown command ${JSON.stringify(command)}; the commands are ${Object.keys(COMMANDS).join(", ")}, hook`,
			);
		const parsed = parseArgs(command, argv.slice(1), withBodyFiles(command, def.flags), def.rest);
		if (bool(parsed, "help")) {
			const files = bodyFilesHelp(command, def.flags);
			return { stdout: `${def.usage}\n  ${def.about}\n${files ? `  ${files}\n` : ""}`, stderr: "", exit: EXIT.ok };
		}
		const args = readBodyFiles(command, parsed, env.cwd, env.readStdin);
		takeNews(); // what an earlier call in this process left (tests run many)
		const out = await def.run(args, env);
		const exit = out.exit ?? EXIT.ok;
		// Every command that took news while recording prints it (#37, News Report).
		const news = takeNews();
		const data = {
			ok: exit === EXIT.ok,
			command,
			...out.json,
			...(news.length > 0 && !("news" in out.json) ? { news } : {}),
		};
		if (json || bool(args, "json")) return { stdout: `${JSON.stringify(data, null, 2)}\n`, stderr: "", exit, data };
		// run, logs and bisect: stdout is the box command's, and may be piped; news goes to stderr there (#37, Builder 3).
		const boxOut = command === "run" || command === "logs" || command === "bisect";
		const text = [...(out.text === "" ? [] : [out.text.replace(/\n$/, "")]), ...(boxOut ? [] : newsBlock(news))].join(
			"\n",
		);
		const errText = boxOut && news.length > 0 ? `${newsBlock(news).join("\n")}\n` : "";
		return { stdout: text === "" ? "" : `${text}\n`, stderr: errText, exit, data };
	} catch (err) {
		const e = err as Error;
		const code = err instanceof UsageError ? "usage" : err instanceof ApiError ? "server" : "error";
		const message =
			err instanceof UsageError || err instanceof ApiError ? e.message : `${e.message}${e.stack ? `\n${e.stack}` : ""}`;
		// The server refusing (409) is like a collision: exit 2, not a failure.
		const exit = err instanceof ApiError && err.status === 409 ? EXIT.refused : EXIT.error;
		// News taken before the failure still shows.
		const news = takeNews();
		const data = { ok: false, command, error: { code, message }, ...(news.length > 0 ? { news } : {}) };
		if (json) return { stdout: `${JSON.stringify(data, null, 2)}\n`, stderr: "", exit, data };
		return {
			stdout: news.length > 0 ? `${newsBlock(news).join("\n")}\n` : "",
			stderr: `abso ${command}: ${message}\n`,
			exit,
			data,
		};
	}
}
