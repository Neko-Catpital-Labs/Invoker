---
name: remote-ci-verify
description: Push the current branch and verify it against the CI-equivalent test surface on an available SSH remote target, including selecting a target not currently used by Invoker, creating a temporary remote worktree, and running `pnpm run test:all` with CI-style setup. Use when you need pre-merge confidence that mirrors `.github/workflows/ci.yml` more closely than local-only tests.
---

# remote-ci-verify

Use the helper script in this skill to run CI-style verification on a remote SSH target.

## Command

```bash
bash skills/remote-ci-verify/scripts/run-remote-ci-verify.sh
```

## What it does

1. Push the current branch to `origin` (configurable).
2. Read SSH targets from Invoker config (`INVOKER_REPO_CONFIG_PATH` or `~/.invoker/config.json`).
3. Skip targets that appear busy in Invoker DB (`remote_target_id` with active statuses).
4. Pick the first reachable SSH target.
5. On remote host: clone/reuse repo cache, create temporary worktree for the branch, then run CI-equivalent setup and tests.
6. Clean up worktree and lock by default.

## CI-equivalent remote flow

By default the remote flow runs:

```bash
pnpm install --frozen-lockfile
pnpm --filter @invoker/ui build
pnpm --filter @invoker/app exec playwright install --with-deps
CI=true pnpm run test:all
```

This mirrors the core test job in `.github/workflows/ci.yml` (`test-all`).

## Common env overrides

- `CI_VERIFY_TARGETS=target-a,target-b`: limit target IDs.
- `CI_VERIFY_PUSH=0`: skip `git push`.
- `CI_VERIFY_FORCE_PUSH=1`: force push with lease.
- `CI_VERIFY_REMOTE_TEST_COMMAND='pnpm run test:all:extended'`: override test command.
- `CI_VERIFY_REMOTE_INSTALL_PLAYWRIGHT_DEPS=0`: skip Playwright system deps step.
- `CI_VERIFY_KEEP_REMOTE_WORKTREE=1`: keep remote worktree for debugging.
- `CI_VERIFY_DB_PATH=/path/to/invoker.db`: override busy-target DB source.

## Assumptions

- `remoteTargets` are configured in Invoker config with valid `host`, `user`, `sshKeyPath`.
- The remote machine has `git`, `node`, and `pnpm` available in non-interactive SSH sessions.
- Remote host can clone/fetch the repository URL used by local `origin`.
