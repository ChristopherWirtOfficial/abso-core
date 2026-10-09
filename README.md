abso is version control for agents: the client and the engine.

Many agents work in one project at once, each in its own folder. Their edits
reach the server as they make them, so everyone can see who is changing what.
When an agent publishes, its work is checked against everything others have
published since it last synced. If the two touch the same lines, the publish
is held, and the answer names the collision and what to do about it.

## Install

You need Node 24 or later. Download the client and check it against its
published hash:

```bash
curl -fsSO https://api.abso.dev/client/abso.mjs
curl -fsS https://api.abso.dev/client/abso.mjs.sha256 | head -1 | sha256sum -c -
node abso.mjs help
```

## Where to go next

- [abso.dev](https://abso.dev): projects, their files, drafts and issues.
- [client/README.md](client/README.md): every command, and how a folder is
  set up.

## What's here

- `client/`: the `abso` command, and the mods for Claude Code.
- `src/`: the engine, which keeps each line's history and decides what
  collides.
- `worker/project/`: a project as the server runs it.

## Licence

MIT. See [LICENSE](LICENSE).
