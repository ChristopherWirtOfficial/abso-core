# abso

abso is version control for agents: the client, the engine and a server you can run on your own Cloudflare account.

Many agents work in one project at once, each in its own folder. Their edits
reach the server as they make them, so everyone can see who is changing what.
When an agent pushes, its work is checked against everything others have
pushed since it last pulled. If the two touch the same lines, the push
is held, and the answer names the collision and what to do about it.

This repository holds the command-line client, the engine, and a server built
on Cloudflare Workers, Durable Objects and Artifacts
([server/README.md](server/README.md)), all MIT-licensed. abso also runs as a
hosted service at [abso.dev](https://abso.dev), which adds accounts, CI and a
website for watching your agents' work.

## Run your own server

It needs a Cloudflare account on the Workers Paid plan: Artifacts isn't on the
Free plan.

```bash
cd server && npm ci
npx wrangler login
npx wrangler deploy                   # prints the server's address
npx wrangler secret put ABSO_TOKEN    # the token your agents use
```

The server refuses every call until `ABSO_TOKEN` is set. wrangler needs Node
22 or later. On Node 20, run it through npm's Node 22 instead:
`npx -y node@22 node_modules/wrangler/bin/wrangler.js deploy` (and the same
for `login` and `secret put`).

`npm ci` in the root and in `server/` also patches the installed
isomorphic-git (1.44.2 only) so the server's git pushes and fetches stream a
chunk at a time instead of holding a whole pack in memory. It checks the
package's sha256 before and after, and refuses any other version; the
scripts are in `server/scripts/`. That's the "Git capacity runtime patch"
line you'll see during installs and builds.
[server/README.md](server/README.md) has the rest: pointing the client at it,
two agents and a held collision, plain git through Artifacts, and its limits.

## Install the client

It needs Node 20 or later:

```bash
npm i -g @abso-cli/abso
abso help
```

`npx @abso-cli/abso` runs it without installing. The same client is also one
file, [abso.mjs](https://api.abso.dev/client/abso.mjs), with its sha256 beside
it at `abso.mjs.sha256`.

From this repository's root (not `server/`), on Node 20 or later, build it
first:

```bash
npm ci
npm run build
node client/bin/abso.mjs help
```

`npm run build` writes the whole client as one plain-JS file,
`client/bin/abso.mjs`, from `client/abso.ts`; build again after pulling. On
Node 24, `node client/abso.ts` runs the TypeScript itself, with no build.
`npm run pack:npm -- <version>` packs the same build as the npm package.

## Where to go next

- [abso.dev](https://abso.dev): projects, their files, drafts and issues.
- [client/README.md](client/README.md): every command, and how a folder is
  set up.

## How abso works

- **Shared and drafts.** A project has *shared*, its pushed history as
  numbered versions. Each agent works in its own folder, on its own *draft*.
- **Edits are recorded as they happen.** Everyone can see work in progress
  (`abso where`, `abso who <file>`).
- **Lines, not snapshots.** Every line has its own identity, author and
  history, through edits and moves.
- **Push checks first.** `abso push` adds your draft to shared. It's
  refused if your work collides with something pushed since you last
  pulled:
  - both sides changed the same lines;
  - you use a top-level name whose definition someone else changed;
  - both sides define the same name in one file.

  Nothing is merged silently.
- **Settle.** A collision shows up at pull with both sides. `abso settle`
  keeps yours, theirs or both, and the other author hears what was kept.
- **Agents talk through abso.** Start notes (`abso start`) say what you're
  working on. News reaches an agent in the answer to its next command. Asks
  wait for an answer.

## Use it

This needs an account on [abso.dev](https://abso.dev). Without one, you can
read a public project (below) or run your own server
([server/README.md](server/README.md) runs one locally, with no account at
all).

Sign this machine in once. `abso login` opens abso.dev in your browser with a
code filled in; a person signed in there approves it and chooses which
projects its agents may join:

```bash
abso login
```

Make the project on abso.dev with New project. Then each agent joins it once,
in a folder of its own:

```bash
abso join <project>
cd <project>
```

On abso.dev, projects start on the website, not with `abso init`. `abso init`
starts a project from a folder on your own server; see
[server/README.md](server/README.md).

The agent is named after the machine (`-2`, `-3` for the next ones).
`--agent <name>` and `--dir <folder>` choose for yourself. Each agent gets its
own key.

A public project, such as this one, can be read with no sign-in:

```bash
abso join abso-core --reader
```

That folder sends no sign-in and records nothing. `status`, `log`, `show`,
`files`, `blame`, `why`, `where`, `issues`, `issue` and `search` work there,
and every other command is refused. `show` takes a version and a file:
`abso show 186:README.md`.

Then the loop:

```bash
abso pull                          # bring in what others pushed
abso start "what I'm doing" files  # say what you're working on
# edit files
abso push -m "why"                 # add your draft to shared
```

If `push` is refused, run `abso pull`. Then settle each collision it
marks, and push again:

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
- `server/`: the open server: a Worker, a Durable Object per project, and
  each project pushed out to its own Artifacts repo.

Developing takes Node 24, which runs the `.ts` files directly:

```bash
npm ci
npm run check      # about 10 minutes: typechecks, then about 1,200 tests
```

Before a push, `npm run check:changed` is enough: it runs the tests that
import what you changed, the typecheck when it reaches it, and biome on your
files (`--list` shows the plan; name files after `--` to pick them yourself).
The merge queue runs the full check on every push, so running it by hand
too only adds minutes. check:changed runs the full check itself when you
change setup (package.json, the lockfile, tsconfig.json, abso.json,
biome.json).

## History

abso-core starts from a fresh first version: the tool as it stood when it
moved out of abso's private repository. The history before that isn't public.

## License

MIT. See [LICENSE](LICENSE).
