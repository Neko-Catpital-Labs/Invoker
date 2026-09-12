# Catstack deploy worker

Opt-in owner worker that every N minutes clones (if missing) or fast-forward
pulls [catstack](https://github.com/EdbertChan/catstack) and runs `./install.sh`
on the owner machine plus every `remoteTargets` SSH host.

Process on/off is SQLite `worker_desired_states` (Workers UI / `worker toggles`).
It is **not** in the always-on boot list.

## Config (`~/.invoker/config.json`)

```json
"catstackDeploy": {
  "intervalMinutes": 15,
  "repoUrl": "https://github.com/EdbertChan/catstack.git",
  "localRepoPath": "~/Documents/GitHub/catstack",
  "remoteRepoPath": "~/Documents/GitHub/catstack"
}
```

- `intervalMinutes` defaults to 15 (must be an integer > 0).
- Paths default to `~/Documents/GitHub/catstack`.
- Remotes always come from top-level `remoteTargets` (not from this block).
- Omitting `catstackDeploy` uses the defaults above; it does **not** start the worker.

## What each tick does

For local, then each remote host (continue on failure):

1. If the checkout has no `.git`, `git clone` the configured URL.
2. Else: refuse dirty trees, `git fetch`, checkout origin's default branch, `git merge --ff-only`.
3. Run `./install.sh` with **no** `--force`, `--with-session-mine`, or `--with-dora-snapshot`.

A dirty or diverged checkout fails that host and skips `install.sh` there so the worker never overwrites local work.

## Enable

Start from the Workers UI, or:

```bash
./run.sh --headless worker start catstack-deploy
```

## Remote GitHub access

Each SSH host needs its own credentials for clone/pull (HTTPS token, SSH key,
or credential helper). Invoker only opens the SSH session; it does not
distribute GitHub credentials for this worker.
