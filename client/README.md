# abso: the client

The command-line client and the Claude Code hook for abso, version control
for agents. [README.md](../README.md) at the top says what abso is and how to
install the client as one file.

It is plain TypeScript that Node 24 runs directly, and it uses nothing outside
this folder, so the folder can be shipped as it is.

```bash
node client/abso.ts help
```

On Node 20 or later, run `client/bin/abso.mjs` instead: the same client built
into one plain-JS file, committed, so a fresh clone needs no install or build.

```bash
node client/bin/abso.mjs help
```

Node 20 can't run the `.ts` files (it has no type stripping). After changing
anything the client imports, `npm run build:client` rebuilds `bin/abso.mjs`;
push it with the change. The project's check (`npm run check:client-bundle`)
fails while the file isn't a build of the client as it is.

### Running it from a git checkout

`client/launch.mjs` runs the client from a git checkout of abso and keeps the
checkout current. Point your `abso` command at it:

```bash
node /path/to/abso/client/launch.mjs help
```

It runs a bundle of the client when one matches the checkout's commit, which
starts several times faster than the TypeScript, and `client/abso.ts`
otherwise. Every few minutes it fast-forwards the checkout (on `main` only)
and builds the bundle in the background, with esbuild if the checkout has it.
It never changes the command's output or exit code, and writes its own notices
to `~/.abso/launcher.log`.

Point it at a clone or worktree that nobody edits in. The bundle is keyed on
the commit, so changes that aren't committed don't run until the next commit.

## Setting up a folder

### Requesting access at login

An agent can request the access it needs when starting a box login:

```bash
abso login --projects alpha,beta --role writer --max-agents 1 --days 30 --no-browser
```

The client sends a `requested_grant` with the device request: `projects`
(each with `project` and `role`), `max_agents`, and `days`. Only supplied
fields are sent; project roles default to `writer`. The role option requires
projects. Agent limits range from 1 to 50 and durations from 1 to 90 days.
The person approving still chooses the actual grant and can narrow or reject
the request. Servers must support requested grants to prefill their approval
page; older servers may ignore the suggestions. Without these options, login
works as before. The request itself never authorizes access.

Folders and machines set up before abso had its name keep working: the older 
`.avcs/` folder, `~/.avcs/` files, `AVCS_` environment names and `.avcsignore` are 
read when the new ones are not there. New things are written under the new names.

The token comes from the `ABSO_TOKEN` environment variable, or else from
`~/.abso/token`, outside every repo. It is never written into the folder.
It goes only to abso's server (`https://api.abso.dev`) and its Issues Worker
(`https://issues.abso.dev`), to servers this
machine names, and to this machine itself, since any `.abso/config.json` can
name a server and anyone can write one. A folder naming another server is
refused before any call. To use a server you run, or a test one, name it in
`~/.abso/servers.json`, beside the token, with its Issues Worker if it has one:

```json
{ "servers": { "https://abso.example.com": { "issues": "https://issues.example.com" } } }
```

`ABSO_TRUSTED_SERVERS` (comma-separated) adds servers for one shell, and
`ABSO_ISSUES_SERVER` names the Issues Worker. The mods follow the same rule.
Off this machine only `https://` servers count. A server you trust gets your
token: the same token goes to every server named, so name only servers you
would hand it to.

Every path a pull, switch, join or restore answer names is checked before
the client touches the disk: nothing is written outside the folder, into
`.git`, `.claude` or `.abso` (in any case), onto a Windows device name, or
through a folder that is a link. A refused path is named in the output
("REFUSED ... paths from the server").

```bash
# Create a project from a folder. The folder becomes agent "lead"'s folder.
abso init ./regex --server https://<worker> --project regex --agent lead

# Each agent joins in its own folder.
abso join regex --agent backtracker --server https://<worker> --dir ./backtracker
```

Here `abso` means `node <repo>/client/bin/abso.mjs` (Node 20 or later), `node <repo>/client/abso.ts` (Node 24), or `node abso.mjs` for the one-file client.

## Working

| Command | What it does |
| --- | --- |
| `abso record [--all]` | Sends every file that changed since the server last heard about it. Edits by Claude Code go through the hook; this catches everything else (shell commands, other editors, a hook that failed). |
| `abso push -m "why" [--as-is]` | Records, then adds the draft to shared. Refused (exit 2) when it collides with work pushed since the last pull, each collision showing both sides; or while a file still holds collision markers from a pull. Settle them first (`abso settle`, or edit them away); `--as-is` keeps both sides in every marked file and pushes. The output names what each settled collision kept, and the other author hears it. |
| `abso push -m "why" --check "<command>"` | Pulls, runs the command in your box on your draft with newest shared, and pushes only if it exits 0, so two changes that each pass alone can't turn shared red. Use the project's own script (`--check "npm run typecheck"`), and give the box its dependencies once first with `abso prep 'npm ci --ignore-scripts'`: without a prep the box has no `node_modules`, and when the folder has a `package-lock.json`, `--check` refuses rather than trust that run. It says when shared moved during the check, and `abso bisect -- <command>` finds the first version where a check fails. |
| `abso settle <file...> --yours\|--theirs\|--both` | Settles the collisions a pull marked in these files. Where lines changed on both sides, pull writes a marker block: `<<<<<<< yours (unpublished)`, your lines, `\|\|\|\|\|\|\| before (version N)`, the lines you both started from, `=======`, theirs, `>>>>>>> theirs: <agent>, version N "<message>"`. Settle turns each block into your lines, theirs, or both (yours first), then records. Editing the markers away by hand works too. `abso status` lists the files with markers; box runs fail while they're in the folder. |
| `abso pull` | Records, then brings shared's new work into the folder. A file that collides is left alone and listed; editing it settles both sides. A renamed file is listed as renamed. Up to 8 file names per line; `--verbose` lists every file. `--full` also writes any file of your view the folder is missing, not only what changed since your last pull (`abso join` always does this). A file new in your draft that your ignore rules leave out (an edit mod older than nested ignore files sends them) leaves the draft and stays on disk; push does the same. |
| `abso run <command>` | Sends the folder to the agent's box, runs the command there, streams the output, and exits with the command's code. The words are one shell command, run by the box's `sh`. The box's stdout comes out on stdout and its stderr on stderr, so `abso run "node gen.mjs" > out.ts` keeps progress lines out of the file. abso's own notices (a fresh box, files sent with LF, and the like) and any news go to stderr, so piped output holds only the command's; `--quiet` drops the notices. |
| `abso run --detach ...` | Starts the run and prints its id without waiting; the job goes on in the box. A later `abso run` from the folder replaces the box's files, even while it runs. |
| `abso run --parallel "<command>" "<command>"...` | One upload, then the commands run at once in the box. Each line a command prints starts with its label (`[1]`, `[2]`, ...; the labels are listed first), stdout and stderr kept apart; at the end, each command's exit code, and `abso run` exits with the worst (highest) of them. |
| `abso run --at <version> [--files <glob>] ...` | Runs a past version of the folder's space in the box instead of the folder (for bisecting), or, with `--files`, the folder with only the matching files as they were at that version (`*` within a folder, `**` across folders, comma-separated; a plain path takes a file or a whole folder). The folder is never touched, so nothing old gets recorded. The run sees `AVCS_AT`. |
| `abso run --with <box path>=<local path>[,...] ...` | Adds files, or every file under a local folder, to this run only: they go to the box (text with LF line endings) and are never written to your folder or recorded, so an A/B run leaves the project alone. A path already in the folder is replaced for this run. |
| `abso fetch <glob...>` / `abso run --fetch <glob>[,<glob>...] ...` | Files a run left in the box's `/w` (bash globs: `out/*.png`, `**/*.log`; `fetch` takes them space-separated, `run --fetch` comma-separated in one argument), written into the folder, but only where abso ignores them (add `out/` to `.absoignore`, say), so a fetched file never becomes an edit; the rest are named and left alone, and every path is screened as a pull's are. `run --fetch` fetches when the run ends. The box's `/w` is replaced by your folder on every run; the rest of the box (`/tmp`, `~/.cache`, `/w/node_modules`) lasts between runs until the box stops (idle 30 minutes, or restarted). |
| `abso pause` / `abso resume` | While paused, nothing from the folder is sent: the edit hook skips, `abso record` refuses, and other commands don't record first. For swapping files in by hand; `abso run --at` usually does it better. |
| `abso logs <run id>` | A run's output from its start (stdout and stderr apart), for as long as the box keeps it, waiting until it ends; exits with its code. For a detached run, or one whose connection was lost. |
| `abso run -- <program> <arg...>` | The same, but each word reaches the program exactly as typed: the client quotes it for the box's shell, so quotes, backslashes and regex text (`'a(b)'`, `'\w+'`) need no second layer of quoting. |
| `abso status` | Shared's version, each agent's base and draft, what in this folder is not yet recorded, any file of your view the folder is missing, and files that differ from what abso recorded only in line endings (CRLF on disk; abso records them, and `abso run` sends them, with LF). `--short` prints one word to stamp a build with: the version the folder is on (`214`), with a named draft (`coast@3`), and `+unpushed` when it holds changes not yet pushed. |
| `abso who <file...>` | For each file: who last changed it, who has unpushed changes in it (and at which lines), and whose `abso start` note names it. For asking before you work in someone's file. |
| `abso fix-eol` | Rewrites the files that differ from what abso recorded only in line endings (CRLF here) with LF, as recorded. Their text is unchanged, so nothing is recorded; `abso status` stops counting them. |
| `abso export <dir> [--version <N>]` | Writes one pushed version of this folder's space (the newest unless `--version`) into a folder of its own, for a build that doesn't move while shared does. The folder must be empty, an earlier export (which it replaces, keeping its `node_modules` and whatever `--keep <glob>` names), or inside the abso folder only where `.absoignore` leaves it out. `.avcs-export.json` there names the version. Your folder and your base are untouched. |
| `abso files [glob...]` | The files your folder should hold (your view), marking any it's missing. `--draft <name>` (or `--draft shared`) and `--version <N>` list a space's files as pushed. |
| `abso switch <draft>` / `abso switch shared` | Records, then moves the folder to a named draft (made on shared's newest version if it's new) or back to shared. Your unpushed changes are parked on the server where you leave, and come back when you return. Then it pulls, so the folder shows the space as it is now; collisions are listed as pull lists them. |
| `abso switch -c <draft>` | Starts a new named draft that carries your current unpushed changes. |
| `abso land -m "why"` | Lands your named draft in shared as one unit. Refused only on a collision with work that landed in shared since the draft began. |
| `abso draft-pull` | Moves your named draft onto shared's newest version, then brings that into the folder. |
| `abso diff [path...]` | Records, then shows your unpushed changes line by line, in git's unified format. A path may be a file or a folder (`.` is the folder you're in); a path that matches nothing is named. A file deleted and another added with at least half the same lines show as one rename, as git shows them (`similarity index`, `rename from`, `rename to`). |
| `abso diff <from> <to> [path...]` | What changed between two versions of this folder's space (`--draft <name>` or `--draft shared` for another). |
| `abso restore <file...>` / `--all` | Discards your unpushed changes to those files, like `git restore`. A file that is new in your draft is deleted. |
| `abso restore <file>:<line>[-<line>]` | Puts back only your changes that touch those lines (numbered as `abso diff` shows the file now), keeping your other changes to the file: to drop your copy of what a teammate already did, say. |
| `abso log [path] [-n <count>]` | The pushed versions of this folder's space, newest first: who, when, why and which files, plus any labels, what a drop took out (or which drop took it out), and the first message of an amended version. With a file or folder, only the versions that changed it; a file's log follows it back through renames, like `git log --follow`. Takes `--draft`. `--since <version|30m|2h|1d|20:00|date>` and `--by <agent,...>` filter it; `--count` prints versions and files per agent instead, for progress reports. |
| `abso show <version>` | One version: who pushed it, why, and its diff. `abso show <version>:<file>` prints that file as it was then. Takes `--draft`. |
| `abso announce [--to a,b] <text>` | Tells the project's other agents (or those named) something. Each gets "Announcement from you (as claimed): ..." once, as news on their next edit, or within 30 seconds where the mod runs. |
| `abso news` | The news waiting for you (collisions, changed definitions, moved lines, announcements), each item once. |
| `abso where` | Who is working where: each file with unpushed changes, whose they are, and which lines. |
| `abso blame <file> [--from n] [--to n] [--version n]` | Who wrote each line of the file as shared has it (or had it at a version), and the push that brought it in. `--draft <name>` reads a named draft; `--mine` reads your own view and marks your unpushed lines with `*`. |
| `abso why <file>:<line>` | Why one line of shared is the way it is: its change, its push, its reasons, and any collision it settled. Takes `--draft` and `--mine` as blame does. |
| `abso drop <version...> -m "why" [--with-dependents]` | Takes pushed versions back out of shared as a new version, like `git revert`; history keeps them. Refused (exit 2) when later versions build on them (`--with-dependents` drops those too) or when anyone's unpushed work builds on them. |
| `abso pluck <draft> <version...> -m "why" [--with-dependencies]` | Takes some versions of a named draft into shared as one version, like `git cherry-pick`. The draft stays as it is. |
| `abso amend -m "new message"` | Corrects the message of your newest push in this space. The log keeps the first message. |
| `abso label <name> [--version n] [--remove]` / `abso labels` | Puts a label on a version of shared (the newest by default) or takes it off, like a git tag; `labels` lists them all. |
| `abso follow <label>` / `abso follow --none` | Makes this folder follow a label: every pull takes it to the newest version of shared with that label. `--none` goes back to shared's newest. Saved in `.abso/config.json`. |
| `abso check-ignore <path...>` | Whether abso leaves each path out, and which line of which ignore file decided (see "What is left out"). |
| `abso pipeline check [file] [--on <event>]` | Reads the folder's pipeline file (abso.yml, abso.yaml or avcs.json, or the file named) and lists each problem as `<path>: <message>`: a cycle in needs, a job or pipeline that doesn't exist, secrets in a pipeline a draft can start, keys it doesn't know. Exits 1 on problems; otherwise lists each pipeline's jobs in the order they run. With `--on push|draft|green|land|hand|schedule` (and `--space`, `--pipeline` or `--every`), says which pipelines that event starts, with their jobs in waves that can run side by side, and why the others don't. Reads only the file. The shape is still a draft. |
| `abso issues [--open] [--status <s>] [--agent <a>] [--parent <N>] [--label <l,l>]` | The project's issues, most recently updated first. Statuses come from the work: `abso start --issue N` puts an issue In progress, an open ask makes it Blocked (In review for a review), and `push --done` closes it. `--label friction` keeps the issues with every label named: a ready list of work to pick up. `abso issues --labels` lists the labels in use, with how many issues are open under each. |
| `abso issue new "<title>" --label <l,l>` / `abso issue <N> --label <l,l> --unlabel <l,l>` | Labels an issue, or changes its labels. A label is 1-40 lower-case letters, digits and `- _ . :` (`friction`, `area:client`); what you type is lower-cased. An edit that only changes labels tells nobody unless `--notify` names people. Tool friction goes in its own issue, labeled `friction`. |
| `abso issue draft "<title>"` / `abso issues --drafts` | A draft of an issue: yours alone, with no number and no news. Takes the same fields as `issue new`. `abso issue draft <D> [fields]` changes one, `--open` opens it as an issue (with any fields given over the draft's), `--delete` deletes it. |
| `abso issue <N>` / `abso issue new "<title>"` | One issue: its description, Agent, Blocked by, asks, comments, edits, sub-issues and watchers. `--comment`, `--object` and `--drop` act on it; its agents hear them. `--reopen` opens a dropped issue again. `--done` marks it done by hand, and `--done-by <version>` names the pushed version that did the work. `--title`, `--description`, `--parent`, `--agent` and `--blocked-by` edit it (`none` clears one), and the edit tells its watchers: who opened it, its Agent and agents, its Reviewer, whoever was named in Notify, and whoever commented. `--notify a,b` tells more people; `--quiet` tells nobody. An issue is Blocked until each issue it's blocked by is Done. `new` opens one (`--description`, `--parent`, `--lines <file>:<from>-<to>@<version>`, `--agent`, `--blocked-by`, `--notify`). |
| `abso ask <who> "<question>" [--issue <N>]` | Asks an agent, or a person (`person:<id>`), something; they hear it. `--review`, `--task`, `--due`, `--blocks` and `--options "A\|B"` shape it. |
| `abso ask --withdraw <ask> [--note "why"]` | Takes back an ask you made that no longer needs an answer. It leaves their waiting list and stops holding the issue at Blocked. The ask stays in the issue's history, marked withdrawn, with your note, and they hear it. Only the asker can withdraw an ask, and only while it's unanswered. |
| `abso waiting [--of <who>] [--mine]` / `abso answer <ask> "<words>"` | The open asks, soonest due first, and the answer to one asked of you (in your own words, `--option <N>`, or `--done` for a task). |

Every command takes `--json`.

The Issues commands talk to the Issues Worker beside the folder's server,
with the same token: the one `~/.abso/servers.json` names for that server, or
`ABSO_ISSUES_SERVER`. The token goes there only where it would go as a
folder's server: abso's, one this machine names, or this machine itself.

### Text with several lines: `--comment-file`, `--file`

Windows PowerShell 5.1 passes a quoted argument to a native command badly:
text with several lines can reach abso cut at its first new line, with
nothing said. So every text flag also reads a file: `--comment-file`,
`--description-file`, `--object-file`, `--note-file` and `push
--message-file`. For `ask`, `answer` and `announce`, whose text is their
words, use `--file`. A path of `-` reads stdin. One trailing new line is
dropped, and an empty file is refused.

```
abso issue 12 --comment-file notes/findings.md
abso answer 40 --file answer.md
Get-Content body.md | abso announce --file -
```

### When `timeout` kills a run

The box keeps everything a killed command printed before it died: on a
staging box, `timeout` killing node (writing straight out, through a pipe,
under `npm run`, or 20,000 lines at speed) lost no line. A run that shows no
output after a timeout most likely printed nothing yet. A program that
collects its report and prints it at the end (as the regex harness's
`score.ts` does) prints nothing when it is killed first. To get something
back:

- print progress as you go (to stderr, so `> file` keeps only the result);
- or give `timeout` a signal the program catches, and print what it has
  there: `timeout --signal=INT 200 npm run score:fast`, with
  `process.on('SIGINT', () => { printReport(); process.exit(130); })`;
- or give the program its own time limit, under `timeout`'s.

## The MCP server

`abso mcp` serves the reading commands, and the writing ones an agent uses every
day, as MCP tools on stdin and stdout. Each tool is the command of the same
name (`check-ignore` is `check_ignore`), runs the same code, and answers with the
same text, so the tools and the command line can't drift apart. `json: true` on
a call answers with the command's JSON instead. The folder and the token come from
where the server runs, as for the command line; `folder` on a call points it at
an abso folder inside that one. A call's `folder`, the files the `issue`
tool's `attach` and `clean` name, and the folder its `save-attachments` writes
to, must be in the folder the server started in or below it: anything outside is
refused. Add it to Claude Code with:

```
claude mcp add abso -- node <repo>/client/abso.ts mcp
```

The box commands (`run`, `shot`, `bisect`, `prep`, `logs`, `fetch`) stream for
minutes and stay in the shell, as do `init` and `join`, and the commands that
rewrite history or move between drafts.

## The skill

`abso skill install` writes the abso skill for Claude Code to
`~/.claude/skills/abso/SKILL.md` (`--dir` names another skills folder). The skill
says how to work in an abso folder and what never to share. It's instructions
only: it names no tools to allow, and installing it changes no settings. Its
source is [skills/abso/SKILL.md](skills/abso/SKILL.md). `abso skill show` prints
it. Run `abso skill install` again after updating abso.

## The hook

After each Edit, MultiEdit, Write or NotebookEdit, the hook:

1. finds the abso folder above the edited file (and does nothing outside one);
2. replays the edit on `.abso/known/<file>`, the client's copy of what the
   server has. If the replay gives exactly the file on disk, it sends the edit
   (old and new text, with the session and subagent ids). If not, it sends the
   whole file with `record`. That happens after a shell command changed the
   file, for `replace_all`, or when the server answers "out of step";
3. hands any news back to the agent as extra context.

It never stops the agent. On any error it writes a line to `.abso/hook.log`
and forgets the file's known copy, so the next `abso record` sends it whole.
Every call is logged with its timing. The decisions live in `src/core.ts`,
shared by both forms below.

### Installing it

There are two forms.

- **The mod (in-process; the agent never waits).** This folder is a Claude
  Code plugin whose hook is a function hook (`hooks/register.ts`). It runs
  inside Claude Code: the hook takes a snapshot of the edited file and returns,
  and a queue sends the edits in order on the session's own HTTPS connection
  (about 75 ms each, none of it waited for). News is appended for the model's
  next request; on Claude Code versions without that, it rides on the agent's
  next edit. Every 30 seconds it also asks for news without an edit, so
  announcements reach an agent that isn't editing. Install or update it for every session on the machine with
  `node client/install-mod.ts`, which puts its five files in
  `~/.claude/skills/avcs`. A chat loads the mod when it starts and keeps that
  one: open chats don't pick up a new install, so restart them (or the app) to
  load it.
  `abso status` says when the last edit in a folder came from an older mod
  than the one installed. Or load it
  for one session with `claude --plugin-dir <repo>/client`. Function hooks are
  an early-access Claude Code API; a headless `claude -p` loads them only with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. While the mod is installed, the command
  hook below stands down (`ABSO_HOOK_FORCE=1` overrides), so no edit is sent
  twice.
- **The command hook (about 320 ms per edit), for anything else.** `abso hook`
  reads Claude Code's PostToolUse JSON on stdin, always exits 0, and prints the
  news as `additionalContext`. In the agent folder's `.claude/settings.json`:

  ```json
  {
    "hooks": {
      "PostToolUse": [
        {
          "matcher": "Edit|MultiEdit|Write|NotebookEdit",
          "hooks": [{ "type": "command", "command": "node <path-to-abso>/client/abso.ts hook", "timeout": 10 }]
        }
      ]
    }
  }
  ```

Measured in real sessions against the live server: the plugin takes a
median of 73 ms per edit, and the command hook 319 ms (342 ms when Git Bash
starts it, as Claude Code does on Windows). The difference is a new process
and a new HTTPS connection for every edit.

### Updating the mods, and taking an update back

Every session on the machine runs the installed mods, so an install never
leaves them half-written. `install-mod.ts` and `install-view.ts`:

- stamp the mod with the last commit that changed its files: plugin.json's
  version becomes `0.1.0+702c616` (`.dirty` when the files differ from that
  commit), and the mod sends it with each call to the server as
  `X-Abso-Client`. A commit that changes none of them leaves nothing to
  install, and nothing to restart for;
- check a staged copy first, with `claude plugin validate` and the mod's own
  tests in the plugin test kit, and change nothing if either fails
  (`--unchecked` skips the check);
- then move each file into place with a rename, what the hook imports first
  and plugin.json last, keeping the files they replace as `<file>.prev`.

`node client/install-mod.ts --rollback` puts the previous install back (run
it again to undo that); the same goes for `install-view.ts`. Both take a
folder in place of the skills folder. `abso --version` prints this client's
version and the mods installed on this machine, and says when this client
has a newer mod to install. The command-line client sends its own version
with each call too (`X-Abso-Client: avcs-cli/0.1.0+<commit checked out>`).

## The view (avcs-view)

A second mod, in `client/view`, shows a chat what abso knows about its folder:

- **A status line**, for example
  `avcs: shared · 2 files unpushed · shared is 2 ahead (abso pull) · bob also on your files · 1 news item (/avcs-view)`.
  It shows the space, the files your draft changes, how far shared (or your
  draft) has moved past your base, other agents with unpushed changes in
  the same files, and news you haven't looked at.
- **`/avcs-view`** opens a pane with the whole picture: the space and version,
  your draft's files, work parked in other spaces, who else is on which of
  your files, and the latest news (from `.abso/news.log`, which the hooks and
  commands write).

Outside an abso folder it costs one folder lookup when the chat starts. In one,
it asks the server for `/status` and `/where` every 30 seconds, and a few
seconds after an edit. Install it with `node client/install-view.ts`. Both mods' tests run in
Claude Code's plugin test kit: `node client/test-mods.ts`.

## What the folder holds

- `.abso/config.json`: `{server, project, agent}`. When the folder is a git
  repo, `/.abso/` goes into `.git/info/exclude`. Nothing under `.abso/` is
  ever recorded, pushed or sent to a box.
- `.abso/known/`: the known copy described above.
- `.abso/modes.json`: the executable files and links the server has, as far
  as the client knows. It is to modes what the known copy is to text.
- `.abso/hook.log`: one line per hook call.
- `.abso/news.log`: the news the agent was given, one dated line each.
- `.abso/run.log`: when `abso run` reconnected to a run, or started it again because the connection failed before the server answered (up to 3 more tries, 0.5 to 3 seconds apart; never once the server has answered), and why.

## Empty files, the executable bit and links

An empty file is a file like any other; only a deleted file is gone. The
server keeps each file's executable bit and whether it is a symbolic link.
The client sends only the changes, after the files' text:

- **The executable bit** is read from disk and set on disk, except on Windows,
  which has no such bit. There, like git's `core.fileMode=false`, a file keeps
  the bit the server has, and `abso run` sends it to the box.
- **A link** is never followed. Its text is "" and its target is its mode. Where
  links can't be made (Windows without Developer Mode), pull writes a plain
  file that holds the target, as git does with `core.symlinks=false`. That
  file counts as the link, and editing it changes the target. The hooks leave
  links to `abso record`.

## What is left out

Always: `.git`, `.abso`, `.claude` and `node_modules`, in any case. Beyond
those, abso follows git's ignore rules, for `.gitignore` and `.absoignore`
alike, except for case:

- Any folder may have either file. Its patterns are relative to its folder,
  and a deeper file beats a shallower one. In one folder, `.absoignore` beats
  `.gitignore`, so it can bring back what `.gitignore` leaves out (`!dist/`).
- Below those come `.git/info/exclude`, then git's global excludes file
  (`core.excludesFile`, or `~/.config/git/ignore`).
- `!`, `**`, `?`, `[...]`, a leading `/` (anchored), a trailing `/` (folders
  only), `\` escapes and trailing spaces all work as in git. The last matching
  line wins.
- Nothing inside an ignored folder can be brought back with `!`, as in git.
- Case: every pattern, from `.absoignore`, `.gitignore` or git's own exclude
  files, matches by the same rule as abso's paths, on every platform:
  any case, and either Unicode form of an accented letter. So `.env` also
  leaves out `.ENV`. This ignores case and Unicode form even where
  `git status` doesn't: in a git repository with `core.ignorecase` off (git
  init leaves it off on Linux), abso can leave out a file git shows.

Binary files (a NUL byte or invalid UTF-8), and text over 2 MB, go up as
blobs: the client uploads the bytes under their SHA-256, records the
hash, and keeps the hashes it knows in `.abso/blobs.json`. Pull, switch and
restore fetch the bytes, and never overwrite a binary file the agent changed
and hasn't recorded. `diff` says `Binary file x changed: <hash> -> <hash>`.
Files over the server's 20 MB limit are left out; `init`, `record` and
`status` name them (`leftOut` in `--json`), and what the server has of them
stays. `abso run` still sends every file to the box.

`abso init` writes a starting `.absoignore` (Claude Code state and operating
system files) when the folder has none. `abso check-ignore <path...>` says
whether each path is left out and which line of which file decided.
`client/test/ignore.test.ts` checks the rules against `git check-ignore`.

## Line endings

The server keeps text with LF endings and a final newline. When pull, join or
restore rewrites a file that's already in the folder, the file keeps its own
style: CRLF if it uses CRLF, and no final newline if it has none. In a file with
mixed endings (or a lone CR), each unchanged line keeps its own ending and a
changed or new line takes the most common one. A file new to
the folder gets the endings git would give it on checkout: in a git repository
the client asks git (`git check-attr text eol` for `.gitattributes`, and
`core.autocrlf` and `core.eol`); outside one, LF. `record` compares text in the
server's form, so endings alone never count as a change.

## Testing

`client/test/fake-server.ts` is a local stand-in for the Worker. It runs the
real engine (`worker/project/project.ts`) in memory behind the same routes, and
runs `abso run` commands in a temp folder instead of a box. The tests run the
client against it:

```bash
node --test client/test/client.test.ts
```

To point a real folder at it, run `node client/test/fake-server.ts 47811`.
It takes the token from `ABSO_TOKEN` (default `fake-token`).
