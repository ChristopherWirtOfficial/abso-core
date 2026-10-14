# abso's open server

One Cloudflare Worker that hosts abso projects on your own Cloudflare account. Each project is its own Durable Object,
with its history in that object's SQLite storage, and its shared history is pushed out to its own Artifacts git repo.
Issues, asks and news run in a second Durable Object per project, served under `/issues`.

Many agents can work in one project at once. Each pushes from its own folder; a push that collides with work pushed
since that agent last pulled is held, and the answer names the collision. Projects don't share anything, so more
projects means more Durable Objects, not a bigger one.

## What you need

- A Cloudflare account with Workers, Durable Objects and Artifacts.
- Node 20 or later.

## Deploy it

From this folder:

```bash
npm ci
npx wrangler login
npx wrangler secret put ABSO_TOKEN     # any long random string: the token your agents use
npx wrangler deploy
```

`wrangler deploy` prints the server's address, such as `https://abso.<your-subdomain>.workers.dev`. Until
`ABSO_TOKEN` is set, the server refuses every call. `GET /version` answers without a token.

Optional: `npx wrangler secret put KEY_HMAC_SECRET` turns on per-agent keys (`abso_sk_...`), issued through
`/admin/agent-keys`, so each agent can have its own credential instead of the shared token.

## Point the client at it

The client is in this repository (`client/abso.ts`). From the repository's root:

```bash
npm ci
export ABSO_TOKEN=<the token you set>
export ABSO_TRUSTED_SERVERS=https://abso.<your-subdomain>.workers.dev
alias abso="node $PWD/client/abso.ts"
```

The client sends its token only to servers you trust, so `ABSO_TRUSTED_SERVERS` (or an entry in
`~/.abso/servers.json`) is needed. Issues go to `<server>/issues` on their own.

Then start a project from a folder of files, and let a second agent join it:

```bash
cd my-project
abso init . --server https://abso.<your-subdomain>.workers.dev --project my-project --agent alice

mkdir ../bob && cd ../bob
abso join my-project --agent bob --server https://abso.<your-subdomain>.workers.dev
```

Each agent works in its own folder: `abso pull`, edit, `abso push -m "why"`. When two agents change the same lines,
the second push is held:

```
Not pushed: 1 collision with work pushed since your last pull.
```

`abso pull` marks the collision, `abso settle <file> --yours` (or `--theirs`, `--both`) settles it, and the push goes
through. Issues and asks work the same way: `abso issue new "<title>"`, `abso ask bob "<question>" --issue 1`,
`abso waiting --mine`. `abso help` lists every command.

## Plain git

Every project's shared is also a git repo in Artifacts, `abso-<project>`, updated at most once a minute while agents
push. Each commit keeps its author and ends with `abso-version: N`.

- `POST /p/<project>/git-remote` with the token answers the repo's address and an hour-long token to clone it.
- A plain `git push` to that repo is taken back in as a new version within about 15 seconds while the project is
  active.

## Local development

```bash
printf 'ABSO_TOKEN=local-test-token\nABSO_ARTIFACTS=off\n' > .dev.vars
npm run dev        # wrangler dev --local
```

Keep `--local`: Artifacts is a remote binding, and without `--local` wrangler dev connects to your account.
`ABSO_ARTIFACTS=off` skips the push out, which nothing local can reach. `test/e2e-transcript.md` is a full session of
the stock client against a local server.

## Limits

- One project is one Durable Object, so it lives within one object's memory (128 MB). The server estimates a project's
  loaded size, holds new pushes at about 95 MB and refuses to load past 114 MB.
- Scale comes from projects: [scale/README.md](scale/README.md) has the harness, and `scale/results/` the first run on a
  deployed server. Two hundred projects with twenty agents each (4,000 agents) pushed 419 times a second, with a median
  push of 372 ms.

## How it fits together

- `src/index.ts`: the Worker's entry.
- `src/router.ts`: authorization (the shared token, or an agent key) and routing to each project's object.
- `src/project-object.ts`: the project's Durable Object: loads the engine from SQLite, answers each call, holds
  oversized projects, and runs the alarm that pushes out to Artifacts and takes plain git pushes in.
- `src/issues/`: issues, asks and news.
- The engine itself is `src/engine/` at the repository's root, the same one the client uses.

### Experimental disk-first rollback floor

Disk-first runtime format 4 is required before compressed projection-priority pages, chunked retry receipts chunked atom-text references or indexed atom-list references are written. Preparation upgrades a format-1, format-2 or format-3 namespace atomically. Older runtimes refuse that namespace before reading or writing; rolling back the executable does not make its derived data readable.

To return to an older runtime, keep writes disabled and rebuild its derived writer, projection and historical namespaces from the canonical log using a compatible implementation. Do not lower the format marker in place. Preserve retry receipts or explicitly resolve outstanding retries before changing their storage format. This is an activation boundary, not authorization to delete project data. The canonical log is unchanged by the format upgrade.


Runtime format 3 also fences chunked atom-text references. Runtimes that only understand format 2 must refuse these derived namespaces. Do not lower the marker to roll back; rebuild compatible derived state while preserving canonical history and retry receipts.

Format 4 additionally fences atom-list references. A format-3 executable must refuse a format-4 namespace; it cannot safely interpret the placeholder arrays.

Format 5 additionally fences indexed insertion runs and lines. Preparation accepts recognized formats 1 through 4 and upgrades atomically. Older executables must refuse format 5. Never lower the marker to roll back.
