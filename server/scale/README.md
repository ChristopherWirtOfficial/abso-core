# Scale harness

`scale.mjs` plays many agents across many projects against an abso open server (`server/`). It talks HTTP directly, as
the client does, so one machine can stand in for thousands of agents. Each project is its own Durable Object and its
own Artifacts repo, so total pushes a second should grow with the number of projects while each project's own latency
stays flat.

## Run it

```sh
# The token: ABSO_TOKEN, or a file. It is never printed.
ABSO_TOKEN=... node server/scale/scale.mjs --server https://abso.<you>.workers.dev --projects 10 --agents 5
node server/scale/scale.mjs --server https://abso.<you>.workers.dev --token-file ~/.abso-open/token --ramp
```

Locally: `cd server && npm run dev` (`wrangler dev --local`, with `ABSO_TOKEN` in `.dev.vars`), then
`--server http://127.0.0.1:8787`.

| Option | Default | What it does |
|---|---|---|
| `--server` | (required) | The server's URL. |
| `--projects` | 10 | Projects in the stage. |
| `--agents` | 5 | Agents per project. |
| `--rounds` | 3 | Edit, record and push rounds per agent. |
| `--overlap` | 0.2 | The share of rounds that edit one of the first lines of a shared file, `hot.txt`, instead of the agent's own file, so some pushes are held. |
| `--prefix` | `scale-<run id>` | Project names: `<prefix>-<stage>-p<n>`. |
| `--ramp` | off | Runs 1×1, 10×5, 50×10, 100×10 and 200×20 in order, one results file per stage, and stops early when errors pass 2%. |
| `--concurrency` | 256 | Requests in flight at once, across every agent. When requests a second come near this divided by the latency, the harness is the limit, not the server: raise it (the first ramp used 800). |
| `--max-seconds` | 240 | No new rounds start after this many seconds in a stage. |
| `--artifacts-sample` | 5 | Projects whose push out to Artifacts is timed. |
| `--artifacts-wait` | 180 | Seconds to wait for that push out. |
| `--token-file` | | Read the token from this file instead of `ABSO_TOKEN`. |
| `--out` | `server/scale/results` | Where the results files go. |

## What each agent does

1. Joins (`POST a/<agent>/sync`) and says what it is starting on (`a/<agent>/starting`).
2. Each round, edits its own file `agents/<agent>.txt`. With the overlap chance, it pulls and changes a line of `hot.txt`
   instead. It records the file (`a/<agent>/record`), pushes (`a/<agent>/publish`) and reads its news (`a/<agent>/news`).
3. A held push pulls and pushes again once with both sides kept, as `abso push --as-is` does after a pull.

Each project starts with `init` and one binary file uploaded to `blobs/<sha256>`.

## What it measures

- Each operation's latency: p50, p95, p99 and max, in milliseconds.
- Pushes a second, overall and per project.
- Held pushes, and how many were still held after the retry.
- Errors by operation and status code.
- Time to Artifacts: for a sample of projects, it polls `GET /p/<project>/out` until `pushed.version` reaches shared's
  version. The server pushes out at most once a minute per project, so expect up to about a minute.

The results are JSON in `results/` (summaries, not per-request logs), and a Markdown summary is printed.
