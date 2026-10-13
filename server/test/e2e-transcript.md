# End to end: the stock client against `wrangler dev --local`

Server: `http://127.0.0.1:8799` (server/ in abso-core, run with `npx wrangler dev --local`, Artifacts off).
Token: an invented local test token in `server/.dev.vars`, given to the client as `ABSO_TOKEN`.
Project: `e2e-1791907434`. Folders are temporary, outside abso-core. Run 2026-10-13T16:03Z.

## Init and join

```
(starter) $ abso init . --server http://127.0.0.1:8799 --project e2e-1791907434 --agent starter
Created project e2e-1791907434 at version 0 from 3 text files in <temp>\starter.
Wrote a starting .absoignore (Claude Code state and operating system files); edit it like .gitignore.
No abso.json written: package.json gives no check or build to guess, so CI has nothing to run on each new version. To give it a check, push an abso.json like {"check": "npm test"} (abso ci --help says what it runs).
This folder is agent starter. Settings are in .abso/config.json.
Edits made by Claude Code reach the server through the abso mod, which isn't on this machine yet: node <abso-core>\client\install-mod.ts installs it, and new chats load it. Anything else: abso record.
[exit 0]
```

```
(alice) $ abso join e2e-1791907434 --agent alice --dir . --server http://127.0.0.1:8799
Joined e2e-1791907434 as alice at version 0: wrote 3 files into <temp>\alice.
Edits made by Claude Code reach the server through the abso mod, which isn't on this machine yet: node <abso-core>\client\install-mod.ts installs it, and new chats load it. Anything else: abso record.
[exit 0]
```

```
(bob) $ abso join e2e-1791907434 --agent bob --dir . --server http://127.0.0.1:8799
Joined e2e-1791907434 as bob at version 0: wrote 3 files into <temp>\bob.
Edits made by Claude Code reach the server through the abso mod, which isn't on this machine yet: node <abso-core>\client\install-mod.ts installs it, and new chats load it. Anything else: abso record.
[exit 0]
```

## Both agents edit and push (different files)

```
(alice) $ abso push -m Alice edits line two
Recorded first: 1 changed (hello.txt).
Pushed version 1.
[exit 0]
```

```
(bob) $ abso push -m Bob writes the notes
Recorded first: 1 changed (notes.md).
Pushed version 2. It went on top of version 1 (alice: "Alice edits line two"), which your folder doesn't have yet. Nothing of theirs was overwritten; run abso pull to see both.
[exit 0]
```

## A collision: both change line four

```
(alice) $ abso pull
Pulled to version 2: 1 file updated, 0 deleted.
  updated: notes.md
[exit 0]
```

```
(bob) $ abso pull
Pulled to version 2: 1 file updated, 0 deleted.
  updated: hello.txt
[exit 0]
```

```
(alice) $ abso push -m Alice rewrites line four
Recorded first: 1 changed (hello.txt).
Pushed version 3.
[exit 0]
```

```
(bob) $ abso push -m Bob rewrites line four
Recorded first: 1 changed (hello.txt).
Not pushed: 1 collision with work pushed since your last pull.
  hello.txt:
    yours (line 4):
      line four, as bob wants it
    theirs, by alice in version 3 ("Alice rewrites line four") (line 4):
      line four, as alice wants it
Run abso pull: each of those files comes back holding both sides' lines, with no markers. Edit it to what it should be, then push again.
News:
  alice pushed "Alice rewrites line four" (version 3), which changes hello.txt lines 4-4, where your draft also changes lines; run abso pull to see both versions.
[exit 2]
```

## Log and status

```
(bob) $ abso log
shared is at version 3.
version 3 by alice, 2026-10-13 16:03 UTC: Alice rewrites line four
  1 file: hello.txt
version 2 by bob, 2026-10-13 16:03 UTC: Bob writes the notes
  1 file: notes.md
version 1 by alice, 2026-10-13 16:03 UTC: Alice edits line two
  1 file: hello.txt
version 0 by init, 2026-10-13 16:03 UTC: Start the project
  3 files: .absoignore, hello.txt, notes.md
[exit 0]
```

```
(bob) $ abso status
Project e2e-1791907434: shared is at version 3. This folder is bob, working in shared. Signed in with shared token.
Everything in this folder is recorded.
Agents:
    alice, base 3, 0 draft changes
  * bob, base 2, 1 draft change: hello.txt
    starter, base 0, 0 draft changes
[exit 0]
```

```
(alice) $ abso status
Project e2e-1791907434: shared is at version 3. This folder is alice, working in shared. Signed in with shared token.
Everything in this folder is recorded.
Agents:
  * alice, base 3, 0 draft changes
    bob, base 2, 1 draft change: hello.txt
    starter, base 0, 0 draft changes
[exit 0]
```

## Other checks against the same server, with curl

- No token, or a wrong one: 401 `missing or wrong token`. `GET /version` answers without one.
- Per-agent keys (`AGENT_KEYS=on`, a local `KEY_HMAC_SECRET`): `POST /admin/agent-keys` without `x-abso-admin` is 403; with it, a writer key for `carol` is issued and listed. Carol's key syncs as carol; as `dave` it is 403 `that key is not for this agent`; on another project, 403 `that key is not for this project`.
- Blobs: a PUT whose bytes don't hash to the name is 400 `the bytes hash to …, not …`; the right hash is stored and read back; a name that isn't a SHA-256 is 400.
- `GET head` answers `{version, at}` from storage. `GET feed?from=<end>&wait=3` holds for 3 seconds, then answers with no events.
- `/issues/p/<project>/...` reaches the issues stand-in (404 `issues aren't on this server yet`) after auth.
- `POST git-remote` with Artifacts off: 501 `this server has no Artifacts binding, so no git remote`.
