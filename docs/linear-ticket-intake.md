# Linear → Invoker ticket intake

Worker: [`scripts/linear-ticket-intake.sh`](../scripts/linear-ticket-intake.sh) (DO1 cron companion to `daily-e2e-do-submit`).

## Labels

| Label | Meaning |
| --- | --- |
| `invoker-ready` | Poll this issue; attempt plan + submit |
| `invoker-needs-input` | Completeness gaps; edit ticket and keep/re-add `invoker-ready` |
| `invoker-running` | Plan submitted; Invoker owns execution / PR |

UI / interaction tickets stay unlabeled. You keep those.

`idea-skip` is written by the [cross-repo-research worker](cross-repo-research-worker.md) for
research verdicts that should not become Invoker work.

## Ticket body contract

Optional structured lines (inferred from the title when missing Goal/Motivation):

```
Repo: https://github.com/org/repo
Verify: bash scripts/repro-foo.sh
Files: path/to/file.ts
Goal: Make the shared repro exit 0
Motivation: Users hit a null deref when YAML omits name
Safety invariant: Other behavior in path/to/file.ts stays identical
```

`Verify` must be a runnable command, not “manually check”.

## Completeness (same as Slack / terminal / chat-submit)

Before submit the worker runs:

```bash
bash skills/plan-to-invoker/scripts/check-planning-completeness.sh <plan.yaml>
```

Rejects leftover `REPLACE_ME` / `TODO`, missing Goal / Motivation / Safety invariant, missing `repoUrl`, or non-runnable Verify. Gaps are commented on the Linear issue; nothing is submitted.

## Planner

Default (one-file + one Verify): render the `bugfix` formula and specialize placeholders from the ticket title/description — fill Goal/Motivation from the title when present; never leave `REPLACE_ME`.

Multi-layer / stack tickets: set `INVOKER_LINEAR_PLANNER_CMD` to a PlanConversation-backed planner (same shape as Slack bug-scan: ticket JSON on stdin, plan path on stdout). Completeness gate still runs before submit.

## Env

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` / `INVOKER_LINEAR_API_KEY` | Linear GraphQL |
| `INVOKER_LINEAR_FIXTURE_ISSUES` | JSON issues file (tests; skips network) |
| `INVOKER_LINEAR_DRY_RUN=1` | Log only |
| `INVOKER_LINEAR_SUBMIT_CMD` | Default `./submit-plan.sh` |
| `INVOKER_LINEAR_COMMENT_CMD` | Stub for comment/label mutations in tests |
| `INVOKER_LINEAR_WORK_DIR` | Ledger + rendered plans |
| `INVOKER_LINEAR_RESUBMIT_GUARD_MIN` | Default 1200 |
| `INVOKER_LINEAR_PLANNER_CMD` | Optional external planner |
| `INVOKER_LINEAR_BASE_BRANCH` | Default `master` |

## Cron (DO1)

Companion to `scripts/daily-e2e-do-submit.sh` (same host, separate cadence).

Install / update:

```bash
LINEAR_API_KEY=lin_api_... bash scripts/install-linear-ticket-intake-cron.sh
```

Uninstall:

```bash
bash scripts/uninstall-linear-ticket-intake-cron.sh
```

Manual equivalent (every 15 minutes):

```cron
*/15 * * * * cd /path/to/Invoker && LINEAR_API_KEY=... INVOKER_LINEAR_WORK_DIR=$HOME/.invoker/linear-ticket-intake/work bash scripts/linear-ticket-intake.sh >>$HOME/.invoker/linear-ticket-intake/cron.log 2>&1
```
