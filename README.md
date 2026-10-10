abso is version control for agents: the client and the engine.

Many agents work in one project at once, each in its own folder. Their edits
reach the server as they make them, so everyone can see who is changing what.
When an agent publishes, its work is checked against everything others have
published since it last synced. If the two touch the same lines, the publish
is held, and the answer names the collision and what to do about it.

This repository is the open part of abso: the command-line client and the
engine. It's MIT-licensed. The hosted platform around it (the server, accounts,
containers, CI and the website at [abso.dev](https://abso.dev)) is closed and
isn't here.

## Install the client

It needs Node 20 or later:

```bash
npm i -g @abso-cli/abso
abso help
```

`npx @abso-cli/abso` runs it without installing. The same client is also one
file, [abso.mjs](https://api.abso.dev/client/abso.mjs), with its sha256 beside
it at `abso.mjs.sha256`. From this repository, `node client/abso.ts` runs it.

## Where to go next

- [abso.dev](https://abso.dev): projects, their files, drafts and issues.
- [client/README.md](client/README.md): every command, and how a folder is
  set up.

## How abso works

- **Shared and drafts.** A project has *shared*, its published history as
  numbered versions. Each agent works in its own folder, on its own *draft*.
- **Edits are recorded as they happen.** Everyone can see work in progress
  (`abso where`, `abso who <file>`).
- **Lines, not snapshots.** Every line has its own identity, author and
  history, through edits and moves.
- **Publish checks first.** `abso publish` adds your draft to shared. It's
  refused if your work collides with something published since you last
  synced:
  - both sides changed the same lines;
  - you use a top-level name whose definition someone else changed;
  - both sides define the same name in one file.

  Nothing is merged silently.
- **Settle.** A collision shows up at sync with both sides. `abso settle`
  keeps yours, theirs or both, and the other author hears what was kept.
- **Agents talk through abso.** Start notes (`abso start`) say what you're
  working on. News reaches an agent in the answer to its next command. Asks
  wait for an answer.

## Use it

Sign this machine in once. `abso login` opens abso.dev in your browser with a
code filled in; a person signed in there approves it and chooses which
projects its agents may join:

```bash
abso login
```

Then each agent joins once, in a folder of its own:

```bash
abso join <project>
cd <project>
```

The agent is named after the machine (`-2`, `-3` for the next ones).
`--agent <name>` and `--dir <folder>` choose for yourself. Each agent gets its
own key.

Then the loop:

```bash
abso sync                          # bring in what others published
abso start "what I'm doing" files  # say what you're working on
# edit files
abso publish -m "why"              # add your draft to shared
```

If `publish` is refused, run `abso sync`. Then settle each collision it
marks, and publish again:

```bash
abso settle <file> --yours    # or --theirs, or --both
```

`abso help` lists every command. [client/README.md](client/README.md)
explains each one.

## Servers and tokens

The client reads its token from `ABSO_TOKEN`, or else from `~/.abso/token`.
It never writes the token into a project folder.

It sends the token only to abso's own servers (`https://api.abso.dev` and
`https://issues.abso.dev`) and to this machine. A folder that names any other
server is refused before any call. To trust another server, name it in
`~/.abso/servers.json`, with its Issues server if it has one:

```json
{ "servers": { "https://abso.example.com": { "issues": "https://issues.example.com" } } }
```

`ABSO_TRUSTED_SERVERS` (comma-separated) does the same for one shell. Off
this machine, only `https://` servers count. A server you trust gets your
token: the same token goes to every server you name, so name only servers
you would hand it to.

## What's here

- `client/`: the command-line client, and the Claude Code mod that records
  edits and brings news into an agent's chat.
- `src/engine/`: the engine: lines with identity, drafts, collisions and
  history.
- `src/gitview/`: shared as plain git, and plain git commits taken back in.
- `src/pipeline/`: the pipeline file, which declares the jobs a project runs
  and which ones each event starts.
- `worker/project/`: the answers a project gives: status, log, blame, where,
  the feed and the rest.

Developing:

```bash
npm ci
npm run check
```

## History

abso-core starts from a fresh first version: the tool as it stood when it
moved out of abso's private repository. The history before that isn't public.

## License

MIT. See [LICENSE](LICENSE).
