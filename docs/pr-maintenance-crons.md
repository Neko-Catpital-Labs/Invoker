# PR-maintenance cron jobs

Two scheduled jobs keep open PRs healthy. They **must run on the Invoker owner
host** (a machine running its own Invoker owner + clone) because they reach the
owner over its local IPC socket and read `~/.invoker/invoker.db`.

| Worker | What it does |
| --- | --- |
| `scripts/cron-coderabbit-address.sh` (Job 1) | For open PRs by the author, finds **new** CodeRabbit review comments and launches a standalone `omp` agent on a checkout of the PR head branch. The agent reads the comments + branch commits + the Invoker tasks that produced the PR + the PR summary, judges each concern, and — only for real ones — writes a bash repro proving the finding, fixes the branch, and pushes. |
| `scripts/cron-pr-conflict-rebase.sh` (Job 2) | Finds open PRs whose GitHub merge state is conflicting (`mergeStateStatus == DIRTY` / `mergeable == CONFLICTING`), maps each back to its Invoker workflow, and `rebase-recreate`s it. |

Both run **every 5 minutes** and do **one** operation per tick.

## Mutual exclusion & anti-loop

- **Shared lock** (`cron-pr-lib.sh:cron_lock`) — both jobs grab one lock
  (`flock` on Linux, atomic `mkdir` fallback elsewhere) and hold it for the whole
  synchronous operation, so only one operation (Job 1 *or* Job 2) runs at a time;
  the other exits cleanly and retries next tick.
- **Durable attempt ledgers** (append-only TSV under `~/.invoker`):
  - Job 1: `coderabbit-address-submissions.tsv` — keyed by PR; dedups on the
    latest CodeRabbit comment timestamp; hard cap of `INVOKER_PR_CODERABBIT_MAX_ATTEMPTS` (3).
  - Job 2: `pr-conflict-rebase-submissions.tsv` — keyed by workflow; dedups per
    `(workflow, generation)` (a confirmed rebase-recreate bumps the generation, so
    the next real conflict is allowed exactly once); hard cap of
    `INVOKER_PR_REBASE_MAX_ATTEMPTS` (3). At the cap it posts one PR comment and
    flags the workflow as exhausted (recorded once).

## Install / remove

```sh
bash scripts/install-pr-cron-jobs.sh    # adds both crontab lines (marker-tagged, idempotent)
bash scripts/uninstall-pr-cron-jobs.sh  # removes them
```

Logs go to `~/.invoker/coderabbit-address-cron.log` and
`~/.invoker/pr-conflict-rebase-cron.log`.

## Required environment / secrets

`gh` authenticated as the PR author (scopes `repo, workflow`); `omp` installed
with its creds / `ANTHROPIC_API_KEY` (Job 1); `HOME` set (locates the DB +
ledgers); a built `packages/app/dist` and `@invoker/data-store` (the latter
backs `query review-gate`); and the Invoker owner running so the IPC socket + DB
exist. No keys are passed to Invoker — `omp`/`gh` authenticate themselves.

Overridable env: `INVOKER_GITHUB_TARGET_REPO` (default `Neko-Catpital-Labs/Invoker`),
`INVOKER_PR_CRON_AUTHOR` (default `EdbertChan`), `INVOKER_CODERABBIT_LOGIN`
(default `coderabbitai[bot]`), `INVOKER_PR_CRON_OMP_MODEL`, `INVOKER_OMP_COMMAND`,
`INVOKER_PR_CRON_WORKDIR`, the per-job `*_STATE_FILE` / `*_MAX_ATTEMPTS`, and
`INVOKER_PR_CRON_DRY_RUN=1` (print intended actions only — no dispatch).

## Droplet prerequisites (run once before installing)

Clone the repo, `pnpm install --frozen-lockfile`, `pnpm --filter @invoker/app build`
(+ `@invoker/data-store`), `gh auth login` as the author, install `omp` with its
creds, and start the owner (`./run.sh` or `./run.sh --headless owner-serve`). Then
run `bash scripts/install-pr-cron-jobs.sh` from that clone.

## PR → workflow lookup

Both jobs resolve a PR back to its workflow with the read-only headless query:

```sh
./run.sh --headless query review-gate <prNumber|prUrl> --output json
```

It matches the merge node (`__merge__<workflowId>`) on `review_id` or
`review_url`, preferring a live workflow then the highest generation, and prints
`{}` for an unknown PR.
