// The command table and the dispatcher. main() returns what to print and the
// exit code instead of printing, so tests can call it directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAnnounce, runNews, runStart } from "./announce.ts";
import { ApiError } from "./api.ts";
import { bool, type FlagSpec, type Parsed, parseArgs, str, UsageError } from "./args.ts";
import { bodyFilesHelp, readBodyFiles, withBodyFiles } from "./body-files.ts";
import { boxPublic, boxText, login, loginRequest, logout, readBox } from "./box.ts";
import { runDiff, runFiles, runLog, runRestore, runShow } from "./changes.ts";
import { runCheckIgnore } from "./check-ignore.ts";
import { runCi } from "./ci.ts";
import { clientVersion } from "./client-version.ts";
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
import { configPath, findRoot, installKey, isVisitor, readConfig, readToken } from "./config.ts";
import { newsBlockLines, newsShown } from "./core.ts";
import { doctor, doctorText, plainError, realProbe, whoami } from "./doctor.ts";
import { runDraftSync, runLand, runSwitch } from "./drafts.ts";
import { runExport } from "./export.ts";
import { runBlame, runWhere, runWho, runWhy } from "./history.ts";
import { runAck, runAnswer, runAsk, runIssue, runIssues, runReply, runSearch, runWaiting } from "./issues.ts";
import { adminToken, issuedPublic, keyList, keyListText, keyNew, keyRevoke } from "./key-admin.ts";
import { browserSkip, openInBrowser } from "./open-browser.ts";
import { initInOrg, runOrg, runOrgs } from "./orgs.ts";
import { runUnqueue } from "./queue.ts";
import { runNote, runNotes, runReview } from "./review.ts";
import {
	checkFolderServer,
	chooseServer,
	localRefusal,
	SERVER_ORDER,
	serverFlag,
	serverHelp,
	serverUse,
} from "./server-choice.ts";
import { installSkill, SKILL, skillPath } from "./skill.ts";
import { colorsPass, terminalText } from "./terminal-text.ts";
import { runAmend, runDrop, runFollow, runLabel, runLabels, runPluck } from "./versions.ts";
import { runVisibility } from "./visibility-commands.ts";
import { checkVisitor } from "./visitor.ts";

interface CommandDef {
	readonly flags: FlagSpec;
	readonly usage: string;
	readonly about: string;
	/** Stop reading options at the first word (for `run <command...>`). */
	readonly rest?: boolean;
	readonly run: (args: Parsed, env: Env) => Promise<Output>;
}

/** The server login, box, logout, orgs, org, whoami and doctor act on, in the order every command picks one (server-choice.ts). */
export function boxServer(args: Parsed, env: Pick<Env, "cwd" | "env">): string {
	return chooseServer(serverFlag(args), env.cwd, env.env);
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
		flags: { server: "string", project: "string", agent: "string", "as-is": "boolean", org: "string" },
		usage: "abso init [folder] --project <name> --agent <name> [--as-is] [--org <org>]",
		about:
			"Create a project on the server from a folder's text files The folder becomes that agent's folder. It writes a starting .absoignore, and, when the folder has no avcs.json and package.json gives a check or a build to guess, an avcs.json (setup, check, build and out): what the server's CI runs on each new version of shared. Without one, CI runs what it can guess itself, or nothing. --as-is writes neither: the folder goes up exactly as it is (an import). --org <org> makes it an organization's project: for now that is done on the website, and abso says where.",
		run: (args, env) => {
			const org = str(args, "org");
			return org === undefined ? runInit(args, env) : initInOrg(org, boxServer(args, env));
		},
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
		flags: {
			server: "string",
			"no-browser": "boolean",
			projects: "string",
			role: "string",
			"max-agents": "string",
			days: "string",
		},
		usage:
			"abso login [--no-browser] [--projects <name,name>] [--role <reader|writer|owner>] [--max-agents <1-50>] [--days <1-90>]",
		about:
			"Sign this box in once: it opens the approve page in your browser with the code filled in, prints the link and the code too, and waits while a person approves the code on the website, choosing the projects, the highest role and how many agents. Then abso join in any of those projects gives each agent its own key, with no approval. The box's sign-in is kept in your user folder, never in a project folder, and is never printed. No browser opens with --no-browser or ABSO_NO_BROWSER, over SSH, under CI, or on Linux without a display.",
		run: async (args, env) => {
			const server = boxServer(args, env);
			const open =
				bool(args, "no-browser") || browserSkip(env.env, process.platform) !== null
					? undefined
					: (url: string) => openInBrowser(url);
			const record = await login(server, {
				request: loginRequest(args),
				say: (line) => process.stderr.write(terminalText(`${line}\n`, colorsPass(process.stderr, env.env))),
				open,
			});
			return {
				text: `This box is signed in. ${boxText(record, server).split("\n").slice(1).join(" ")}`,
				json: { box: boxPublic(record) },
			};
		},
	},
	box: {
		flags: { server: "string" },
		usage: "abso box",
		about:
			"What this box's sign-in allows: its projects, the highest role its agents may have, how many agents it has made and may make, and when it expires. Never the credential.",
		run: async (args, env) => {
			const server = boxServer(args, env);
			const record = readBox(server);
			return { text: boxText(record, server), json: { box: boxPublic(record) } };
		},
	},
	whoami: {
		flags: { server: "string" },
		usage: "abso whoami",
		about:
			"Who and where you're signed in: this box's sign-in, as the server sees it (so a revoked one shows), its projects, roles and expiry, and this folder's project, agent and kind of key. Never a credential.",
		run: async (args, env) => {
			const out = await whoami(boxServer(args, env), env.cwd, env.env, realProbe());
			return { text: out.text, json: out.json };
		},
	},
	doctor: {
		flags: { server: "string" },
		usage: "abso doctor",
		about:
			"Checks what commands need, one line each: Node's version, that the server answers, this box's sign-in (present, unexpired, accepted), and this folder's key against its project. A failed check says what to do next, and the exit is 1. Never prints a credential.",
		run: async (args, env) => {
			const checks = await doctor(boxServer(args, env), env.cwd, env.env, realProbe());
			const failed = checks.some((c) => c.result === "fail");
			return { text: doctorText(checks), json: { checks }, ...(failed ? { exit: EXIT.error } : {}) };
		},
	},
	logout: {
		flags: { server: "string" },
		usage: "abso logout",
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
	orgs: {
		flags: { server: "string" },
		usage: "abso orgs",
		about:
			"Your organizations and your role in each, and invitations waiting for you. It reads as the person who approved this box's sign-in (abso login).",
		run: (args, env) => runOrgs(boxServer(args, env)),
	},
	org: {
		flags: {
			server: "string",
			name: "string",
			invite: "string",
			as: "string",
			role: "string",
			remove: "string",
			leave: "boolean",
			members: "string",
			"projects-by": "string",
		},
		usage:
			"abso org <name> [--invite <person>|link [--as owner] | --role <person>=owner|member | --remove <person> | --leave | --members read|write | --projects-by members|owners] | abso org new <name> [--name <shown name>]",
		about:
			"An organization: its projects, people, open invites and settings, as the person who approved this box's sign-in sees them (people and settings only to members). One change at a time. Changes and abso org new are made on the website for now, and abso says where.",
		run: (args, env) => runOrg(args, boxServer(args, env)),
	},
	skill: {
		flags: { dir: "string" },
		usage: "abso skill install [--dir <skills folder>] | abso skill show",
		about:
			"The abso skill for Claude Code: how to work in an abso folder, and what never to share. install writes it to ~/.claude/skills/abso/SKILL.md (--dir names another skills folder) and changes no settings; run it again after updating abso. show prints it.",
		run: async (args, env) => {
			const [verb, ...more] = args.positionals;
			if (verb === "show" && more.length === 0) return { text: SKILL, json: { skill: SKILL } };
			if (verb !== "install" || more.length > 0)
				throw new UsageError("abso skill install [--dir <skills folder>] | abso skill show");
			const path = skillPath(str(args, "dir"), env.cwd);
			const done = installSkill(path);
			const said = { installed: "Installed", updated: "Updated", current: "Already current:" }[done];
			return {
				text: `${said} the abso skill at ${path}. New Claude Code sessions load it.`,
				json: { path, done },
			};
		},
	},
	join: {
		flags: { server: "string", agent: "string", dir: "string", reader: "boolean" },
		usage: "abso join <project> [--agent <name>] [--dir <folder>] [--reader]",
		about:
			"Join a project as a new agent and write its shared files into a folder: --dir, else here when this folder is empty, else ./<project> (which has to be new or empty). Without --agent the agent is named after this box (the name abso login gave it, lower-cased), or the next free <name>-2, <name>-3; that needs the box signed in with abso login. --reader joins as a reader: it reads everything and records nothing, and the server refuses its edits, records and pushes. With --reader and no sign-in, a public project is joined to read signed out: the folder holds only its settings, sends no sign-in, and runs status, log, show, files, blame, why, where, issues, issue and search; every other command is refused.",
		run: runJoin,
	},
	record: {
		flags: { all: "boolean", binary: "string" },
		usage: "abso record [--all]",
		about:
			"Send every file that changed since the server last heard about it (--all: every file). For edits the hook did not see.",
		run: runRecord,
	},
	push: {
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
		usage: 'abso push -m "<why>" [--as-is] [--check ["<command>"]] [--wait <seconds> | --no-wait] [--done]',
		about:
			'Record, then add your draft to shared. Refused when it collides with work pushed since your last pull, or when lines a pull showed changed on both sides are still untouched (--as-is pushes both sides\' lines anyway). --check "<command>" (e.g. --check "npm run typecheck") first pulls, then runs the command in your box on your draft with newest shared, and pushes only if it exits 0, so two changes that each pass alone can\'t turn shared red. --check alone runs the "build" and then the "check" in the project\'s avcs.json (your draft\'s copy), as the server does on each new version. With the merge queue on ("queue": true in avcs.json), a push to shared is queued and lands only once the project\'s check passes on shared with it on top: push waits up to 100 s for that (--wait <seconds> changes it, --no-wait returns at once), then says it landed (exit 0), was turned back with the check\'s output (exit 2, its changes still in your draft), or is still queued (exit 3; the outcome comes as news). --check alone is skipped then, since the queue runs the check. --done takes your start note back once it\'s pushed: this push finishes that work.',
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
			"Make this folder's agent a reader, which reads everything and records nothing (the server refuses its edits, records and pushes), or a writer again. Refused while it has unpushed or parked work.",
		run: runReader,
	},
	settle: {
		flags: { yours: "boolean", theirs: "boolean", both: "boolean" },
		usage: "abso settle <file...> --yours|--theirs|--both",
		about:
			"Settle the collisions a pull marked in these files: each marker block becomes your lines, theirs, or both (yours first), then it records. abso status lists the files with markers.",
		run: runSettle,
	},
	pull: {
		flags: { verbose: "boolean", full: "boolean" },
		usage: "abso pull [--full]",
		about:
			"Record, then bring shared's new work into the folder. Lines changed on both sides are listed as collisions to settle. --full writes any file of yours the folder is missing, not only what changed since your last pull.",
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
			"Move a file in your draft, its lines keeping their history (as git mv), recorded as a move rather than guessed from the folder. The way to change a file's case: README.md and readme.md are one file in abso, and a write under another spelling goes to the existing one, with a warning that names abso mv. It reaches shared with your next push.",
		run: runMv,
	},
	review: {
		flags: { since: "string" },
		usage: "abso review [<id> | v<version> | <agent>] [--since <position|2h>]",
		about:
			"Review is reading what landed. With no change: the changes with anything new since you last looked, newest first (a change is one start note's work, a named draft's, or a lone push), and the mark moves on; --since 2h (or a log position) looks further back without moving it. With a change id, v<version> (the change holding that version of shared) or an agent (its newest change): that change's page, with what it set out to do, its versions, what it settled, its reviewers and its notes.",
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
			"A note on lines: it sits on those lines and follows them as the file changes. The lines' authors and the change's agent hear it as news. The line numbers are as your folder shows the file (it records first); --draft <agent> notes their unpushed work as their draft shows it, --at <version> a version of shared. --object asks for a fix (it shows as addressed once all its lines change); --read says you read it, telling nobody. --reply answers a note; --close closes one of yours.",
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
			"The project's issues, most recently updated first, each with its status, agents, labels, versions and who it waits on. --label keeps the issues with every label named (friction, say); --labels lists the labels in use, with how many issues are open under each; --drafts lists your drafts. A status comes from the work: abso start --issue N puts an issue In progress, an open ask makes it Blocked (or In review, for a review), and push --done closes it.",
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
			"copy-to": "string",
			clean: "string",
			"dry-run": "boolean",
			"save-attachments": "string",
		},
		usage:
			'abso issue <N> --save-attachments <folder> | abso issue <N> --copy-to <project> [--clean <file>] [--dry-run] | abso issue <N> [--comment "..." [--attach <file,file>] | --object "..." | --drop | --reopen | --done [--done-by <version>]] | abso issue <N> [--title "..."] [--description "..."] [--parent <N|none>] [--agent <agent|none>] [--blocked-by <N,N|none>] [--label <l,l>] [--unlabel <l,l>] [--notify <who,who> | --quiet] | abso issue new "<title>" [--description "..."] [--parent <N>] [--lines <file>:<from>-<to>@<version>] [--agent <agent>] [--blocked-by <N,N>] [--notify <who,who>] [--label <l,l>] [--attach <file,file>]',
		about:
			"One issue: its description, Agent, Blocked by, labels, asks, comments, edits, sub-issues and watchers. --comment comments on it and --object objects; its agents hear either. A comment holds up to 4000 characters: a longer --comment (or --comment-file) goes up in parts, split at paragraph breaks and each starting (1/3), (2/3) and so on, and a longer --object is refused before anything is sent. --drop drops it. --reopen opens a dropped issue again. --done marks it done by hand, and --done-by <version> names the pushed version that did it. push --done still marks it done too. --title, --description, --parent, --agent and --blocked-by edit it, and the edit tells its watchers (who opened it, its Agent and agents, its Reviewer, whoever was named in Notify, and whoever commented); --notify tells more people, --quiet tells nobody. --label adds labels and --unlabel takes them off (friction, area:client: lower-case letters, digits and - _ . :); a label-only edit tells nobody unless --notify names people. An issue is Blocked until each issue it's blocked by is Done. abso issue new opens one; --lines ties it to lines at a version of shared, --agent says who it's for, --notify tells people now, and --label labels it. --attach shot.png,after.png puts images on a new issue or a comment (png, jpeg, gif or webp, 10 MB each; the server checks the type by the bytes and takes out metadata such as where a photo was taken. An svg, up to 1 MB, is drawn as a png, and its own file is kept as a download, on servers that take svg), and prints each one's id for the text to point at; the issue's page lists them with a link, and --save-attachments <folder> saves every one on the issue and its comments there as <id>-<name> (an svg's own file too), outside the abso folder or where abso leaves files out. --copy-to <project> copies the issue into another project, with its comments, answered asks and labels, each keeping its author and time; --dry-run shows what would go and writes nothing, and --clean <file> gives cleaned texts by source id as JSON ({title, description, comments: [{id, text}], asks: [{id, question, answer}]}; a comment left out of a given list isn't copied). Copying out of a project on a live server takes an owner of that project. abso issue draft \"<title>\" [the same fields] saves a draft instead: yours alone, with no number and no news; abso issue draft <D> [fields] changes it, --open opens it as an issue, --delete deletes it.",
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
			attach: "string",
		},
		usage:
			'abso ask <who> "<question>" [--issue <N>] [--review | --task] [--due <YYYY-MM-DD>] [--blocks <N,N>] [--options "A|B|C"] [--attach <file,file>] | abso ask <N> | abso ask --withdraw <ask> [--note "why"]',
		about:
			"Ask an agent, or a person (person:<id>), something; they hear it. Who must be one of the project's agents or members; a name that isn't is refused, with the closest one suggested. abso ask <N> shows ask N, open or closed, with its whole thread, its answer and whose turn it is. On an issue, it holds the issue at Blocked (In review for --review) until answered. --task asks for something done instead of an answer; --options gives the choices; --blocks names the issues waiting on it. --attach sends files with the question, as on an issue. --withdraw takes back an ask you made that no longer needs an answer: it leaves their waiting list, stops holding the issue, keeps your --note as why, and they hear it.",
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
		flags: { of: "string", mine: "boolean", asked: "boolean" },
		usage: "abso waiting [--of <agent or person:id>] [--mine] [--asked]",
		about:
			"The open asks, soonest due first: every one, those waiting on someone (--of), or those waiting on you (--mine), each with its newest reply. An ask waits on the one asked until they answer, or on the asker after a reply with --question, until the asker replies. --mine also lists your pushes still in the merge queue and where each stands; the outcome comes as news. --asked lists the asks you sent instead, open ones first, then the latest answered.",
		run: runWaiting,
	},
	answer: {
		flags: { option: "string", note: "string", done: "boolean", attach: "string" },
		usage:
			'abso answer <ask> "<words>" | abso answer <ask> --option <N> [--note "..."] | abso answer <ask> --done [--note "..."], each with [--attach <file,file>]',
		about:
			"Answer an ask of you, in your own words, by picking an option (by number or text), or, for a task, with --done. --attach sends files with the answer. The asker hears it.",
		run: runAnswer,
	},
	ack: {
		flags: {},
		usage: 'abso ack <ask> ["<note>"]',
		about:
			"Acknowledge an ask of you without answering it yet: it's the first reply in its thread. The asker hears it, with your note, and the ask stays open. abso reply adds more; abso answer closes it later.",
		run: runAck,
	},
	reply: {
		flags: { question: "boolean" },
		usage: 'abso reply <ask> "<words>" [--question]',
		about:
			'Add to an ask\'s thread, as its asker or the one asked, open or closed: "ok, let me check", what you found, a follow-up. The other side hears it, and the ask stays as it is; abso answer still closes it. --question, from the one asked, asks the asker something back: the ask waits on them until they reply. On a public project, anyone can read the thread.',
		run: runReply,
	},
	unqueue: {
		flags: {},
		usage: "abso unqueue",
		about:
			"Take back your pushes still waiting in the merge queue: their changes stay in your draft, unpushed. Refused while one is being checked; it lands or is turned back within a few minutes (abso drop takes it back after it lands).",
		run: runUnqueue,
	},
	visibility: {
		flags: { yes: "boolean" },
		usage: "abso visibility [public|private] [--yes]",
		about:
			"Whether the project is public. With no word, says which. public, with --yes, lets anyone read it, signed in or not: files, versions, drafts, notes, Issues, people's names, CI as pass or fail; never keys, CI logs, preview links or boxes. private makes it members-only again. Switching takes the project owner's key (on staging, the shared token works too).",
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
			"The shared version, whether shared is green or red by the project's CI (abso ci has more), who waits in the merge queue, every agent's base and draft, and what in this folder is not yet recorded. --short prints one word for stamping a build: the version this folder is on (214), with the named draft (coast@3), +unpushed when it holds changes not yet pushed, and +queued when a push of yours waits in the merge queue.",
		run: runStatus,
	},
	switch: {
		flags: { carry: "boolean", verbose: "boolean" },
		usage: "abso switch <draft> | abso switch -c <new draft> | abso switch shared",
		about:
			"Move this folder to a named draft, or back to shared. Your unpushed changes are parked where you leave and come back when you return; -c carries them into a new draft instead.",
		run: runSwitch,
	},
	land: {
		flags: { message: "string" },
		usage: 'abso land -m "<why>"',
		about:
			"Land your named draft in shared, as one unit. Refused only on a collision with work that landed in shared since the draft began.",
		run: runLand,
	},
	"draft-pull": {
		flags: {},
		usage: "abso draft-pull",
		about: "Move your named draft onto shared's newest version, then bring that into this folder.",
		run: runDraftSync,
	},
	diff: {
		flags: { draft: "string", agent: "string" },
		usage: "abso diff [file...] [--agent <name>] | abso diff <from> <to> [file...] [--draft <name>]",
		about:
			"Your unpushed changes, line by line, as git prints them (records first). --agent <name>: that agent's recorded, unpushed changes instead, to review them; it changes nothing. With two versions: what changed between them in this space.",
		run: runDiff,
	},
	restore: {
		flags: { all: "boolean" },
		usage: "abso restore <file...> | abso restore <file>:<line>[-<line>] | abso restore --all",
		about:
			"Discard your unpushed changes to those files (--all: to every file), like git restore. The files go back to how your space has them. <file>:<lines> puts back only the changes that touch those lines (numbered as abso diff shows the file now) and keeps your other changes to it.",
		run: runRestore,
	},
	export: {
		flags: { version: "string", keep: "string" },
		usage: "abso export <dir> [--version <N>] [--keep <glob>]",
		about:
			"Write one pushed version of this folder's space (the newest unless --version) into a folder of its own, for a build that doesn't move. The folder must be empty, an earlier export (which it replaces, keeping node_modules and what --keep names), or one .absoignore leaves out; .avcs-export.json there names the version.",
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
		flags: { limit: "string", before: "string", draft: "string", since: "string", by: "string", count: "boolean" },
		usage:
			"abso log [file] [-n <count>] [--before <version>] [--draft <name>] [--since <version|30m|2h|1d|date>] [--by <agent,...>] [--count]",
		about:
			"The pushed versions of this folder's space (shared or a named draft), newest first: who, when, why and which files, and for shared, whether the version passed CI's check (abso ci). With a file: only the versions that changed it. --before <version> starts below that version, so any stretch of history can be listed; the end of the list names the --before for the next older ones. --since takes a version (the versions after it), a span back from now (30m, 2h, 1d), a clock time today (20:00) or a date and time; --by keeps one agent's versions (or several, comma-separated); --count prints versions and files per agent instead of the list.",
		run: runLog,
	},
	show: {
		flags: { draft: "string" },
		usage: "abso show <version> | abso show <version>:<file> [--draft <name>]",
		about: "One version: who pushed it, why, and its diff. With :<file>, that file's text as it was then.",
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
			"Say what you are starting on, before your first edit, so abso where shows it to everyone. Names who already has unpushed changes in those files, and tells them. Nothing is locked; pushing ends the note.",
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
			"For each file: who last changed it, who has unpushed changes in it (and where), and whose abso start note names it. Ask before you start in someone's file.",
		run: runWho,
	},
	where: {
		flags: {},
		usage: "abso where",
		about: "Who is working where: each file with unpushed changes, whose they are, and which lines.",
		run: runWhere,
	},
	blame: {
		flags: { from: "string", to: "string", version: "string", draft: "string", mine: "boolean" },
		usage: "abso blame <file> [--from <n>] [--to <n>] [--version <n>] [--draft <name> | --mine]",
		about:
			"Who wrote each line of the file as shared has it (or had it at --version), and the push that brought it in. --draft reads a named draft; --mine reads your own view, marking your unpushed lines with *.",
		run: runBlame,
	},
	why: {
		flags: { draft: "string", mine: "boolean" },
		usage: "abso why <file>:<line> [--draft <name> | --mine]",
		about:
			"Why one line of shared (or of a named draft, or your own view) is the way it is: its change, its push, its reasons, and any collision it settled.",
		run: runWhy,
	},
	drop: {
		flags: { message: "string", "with-dependents": "boolean" },
		usage: 'abso drop <version...> -m "<why>" [--with-dependents]',
		about:
			"Take pushed versions back out of shared, as a new version: like git revert. History keeps them. Refused when later versions build on them, unless --with-dependents drops those too.",
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
			"Correct the message of your newest push in this space. Only the message changes; the log keeps the original.",
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
			"Make this folder follow a label: every pull takes it to the newest version of shared with that label, not the newest version. --none goes back to following shared.",
		run: runFollow,
	},
	"check-ignore": {
		flags: {},
		usage: "abso check-ignore <path...>",
		about:
			"Whether abso leaves each path out, and which line of which ignore file decided (git's rules, for .gitignore and .absoignore).",
		run: runCheckIgnore,
	},
	pipeline: {
		flags: { on: "string", space: "string", pipeline: "string", every: "string", log: "string" },
		usage:
			"abso pipeline check [file] [--on push|draft|green|land|hand|schedule [--space <name>] [--pipeline <name>] [--every <when>]] | abso pipeline runs [<run>] [--log <pipeline.job>]",
		about:
			"Read the folder's pipeline file (abso.yml, abso.yaml or avcs.json, or the file named) and say what's wrong with it, place by place: a cycle in needs, a job that doesn't exist, secrets a draft could reach, a key it doesn't know. Exits 1 when it has problems. With --on, it says which pipelines that event starts (in shared, or --space), with their jobs in waves that can run side by side, and why each other pipeline doesn't start. It reads only the file. abso pipeline runs asks the server what the project's pipelines did: the runs, newest first; with a run's number, its jobs (state, why, exit, time, an npm or deploy job's phase); with --log <pipeline.job>, that job's output.",
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

const HELP_INTRO = "abso: version control for agents. This is its command-line client.";
const HELP_NOTE =
	"Every command takes --json. Settings live in .abso/config.json (.avcs/config.json in a folder from before the rename). The token comes from ABSO_TOKEN, or else ~/.abso/token (or ~/.avcs/token from before). " +
	"Every command that talks to a server takes --server <url>; one that works only on this machine (skill, check-ignore, pause, resume, fix-eol) doesn't. In a joined folder --server must be the folder's own server: another is refused, never swapped in. An explicit --server is used as given, and no setting redirects it. The server is " +
	SERVER_ORDER +
	": which servers this box is signed in to plays no part.";

/** A command's flags: its own, and --server for every command that talks to a server (server-choice.ts). */
function flagsOf(name: string, def: CommandDef): FlagSpec {
	return serverUse(name) === "local" ? def.flags : { ...def.flags, server: "string" };
}

/** Every command as help shows it, in order: the table's, then the three it doesn't hold. */
function helpEntries(): { name: string; usage: string; about: string; flags: FlagSpec; server?: string }[] {
	return [
		...Object.entries(COMMANDS).map(([name, c]) => {
			const server = serverHelp(name);
			return { name, usage: c.usage, about: c.about, flags: flagsOf(name, c), ...(server ? { server } : {}) };
		}),
		{
			name: "hook",
			usage: "abso hook",
			about: "The Claude Code PostToolUse hook. Reads the hook JSON on stdin; never fails.",
			flags: {},
		},
		{
			name: "mcp",
			usage: "abso mcp",
			about:
				"An MCP server on stdin and stdout: the reading commands and the everyday writing ones as tools, answering with the same text as here. Add it with claude mcp add abso -- abso mcp (on Windows, claude mcp add abso -- cmd /c abso mcp).",
			flags: {},
		},
		{
			name: "--version",
			usage: "abso --version",
			about: "This client's version and commit, and the abso mods installed on this machine.",
			flags: {},
		},
	];
}

function help(): string {
	const entries = helpEntries().flatMap((c) => [
		`  ${c.usage}`,
		`      ${c.about}`,
		...(c.server ? [`      ${c.server}`] : []),
	]);
	return [HELP_INTRO, "", ...entries, "", HELP_NOTE].join("\n");
}

/**
 * help --json: the same entries as data, for a command reference built from the client itself. A flag is
 * "string" (takes a value), "boolean" (stands alone) or "optional" (a value that may be left off); every
 * command also takes --json and --help.
 */
function helpJson(): Record<string, unknown> {
	return {
		ok: true,
		command: "help",
		version: clientVersion(),
		intro: HELP_INTRO,
		note: HELP_NOTE,
		commands: helpEntries(),
	};
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
	return Object.fromEntries(Object.entries(COMMANDS).map(([name, c]) => [name, { ...c, flags: flagsOf(name, c) }]));
}

function newsBlock(news: readonly string[]): string[] {
	return newsBlockLines(news.map((n) => newsShown(n)));
}

/** Whether this folder's calls carry a key or token, for how a refusal is worded. False when that can't be told. */
function carriesCredential(env: Env): boolean {
	try {
		const root = findRoot(env.cwd);
		return root ? readConfig(root, env.env).token !== undefined : readToken(env.env) !== undefined;
	} catch {
		return false;
	}
}

/** git's forms of push and pull that abso doesn't have (#427): one plain line naming the abso way. */
function gitOnlyForm(command: string, words: readonly string[]): string | undefined {
	const has = (...forms: string[]) => words.some((w) => forms.some((f) => w === f || w.startsWith(`${f}=`)));
	if (command === "push" && has("-f", "--force", "--force-with-lease", "--force-if-includes"))
		return "abso push has no --force: nothing overwrites shared. When a push is refused, abso pull brings in the other side and abso settle keeps yours, theirs or both.";
	if (command === "push" && has("-u", "--set-upstream", "--all", "--tags"))
		return "abso push has no upstreams, branches or tags: it adds your draft to shared. A named draft is abso switch <name>; a label is abso label.";
	if (command === "pull" && has("--rebase", "-r", "--no-rebase", "--ff-only", "--ff", "--no-ff", "--squash"))
		return "abso pull has no --rebase or merge modes: it always brings shared under your draft, and lines changed on both sides are listed for abso settle.";
	return undefined;
}

export async function main(argv: readonly string[], env: Env): Promise<MainResult> {
	const command = argv[0];
	const json = argv.includes("--json") && command !== "run" && command !== "logs";
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		if (json) {
			const data = helpJson();
			return { stdout: `${JSON.stringify(data, null, 2)}\n`, stderr: "", exit: EXIT.ok, data };
		}
		return { stdout: `${help()}\n`, stderr: "", exit: EXIT.ok };
	}
	try {
		if (command === "--version") {
			// Loaded only here: it runs git, and no other command needs it.
			const { versionReport } = await import("./install.ts");
			const { newerClientNote } = await import("./client-version.ts");
			const report = versionReport(env.env);
			const root = findRoot(env.cwd);
			let behind: string | undefined;
			if (root) {
				try {
					const server = (JSON.parse(readFileSync(configPath(root), "utf8")) as { server?: string }).server;
					if (server) behind = await newerClientNote(server);
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
				`unknown command ${JSON.stringify(command)}; the commands are ${Object.keys(COMMANDS).join(", ")}, hook, mcp`,
			);
		const gitOnly = gitOnlyForm(command, argv.slice(1));
		if (gitOnly) throw new UsageError(gitOnly);
		const use = serverUse(command);
		const words = argv.includes("--") ? argv.slice(1, argv.indexOf("--")) : argv.slice(1);
		if (use === "local" && words.some((w) => w === "--server" || w.startsWith("--server=")))
			throw new UsageError(localRefusal(command));
		const parsed = parseArgs(command, argv.slice(1), withBodyFiles(command, flagsOf(command, def)), def.rest);
		if ((command === "push" || command === "pull") && parsed.positionals.length > 0)
			throw new UsageError(
				`abso ${command} takes no remote or branch: it ${command === "push" ? "adds your draft to shared" : "brings shared into this folder"}. A named draft is abso switch <name>.`,
			);
		if (bool(parsed, "help")) {
			const files = bodyFilesHelp(command, def.flags);
			const server = serverHelp(command);
			return {
				stdout: `${def.usage}\n  ${def.about}\n${server ? `  ${server}\n` : ""}${files ? `  ${files}\n` : ""}`,
				stderr: "",
				exit: EXIT.ok,
			};
		}
		// --server is checked before anything is read or sent: a bad value, or (for a command on a joined folder)
		// a server that isn't the folder's own, is refused here.
		const named = use === "local" ? undefined : serverFlag(parsed);
		if (named !== undefined && use === "folder") checkFolderServer(command, named, env.cwd);
		// A folder that reads signed out runs its reads and nothing else, refused before any call.
		const root = findRoot(env.cwd);
		if (root !== undefined && isVisitor(root)) checkVisitor(command, parsed, readConfig(root, env.env).project);
		const args = readBodyFiles(command, parsed, env.cwd, env.readStdin);
		takeNews(); // what an earlier call in this process left (tests run many)
		const out = await def.run(args, named === undefined ? env : { ...env, server: named });
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
		// run, logs and bisect: stdout is the box command's, and may be piped; news goes to stderr there (#37).
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
			plainError(err, carriesCredential(env)) ??
			(err instanceof UsageError || err instanceof ApiError
				? e.message
				: `${e.message}${e.stack ? `\n${e.stack}` : ""}`);
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
