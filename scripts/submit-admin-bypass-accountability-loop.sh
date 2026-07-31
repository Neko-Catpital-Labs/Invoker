#!/usr/bin/env bash
#
# Submit the accountability version of the admin-bypass babysit loop.
#
# The script keeps the operational prompt in source control so future runs do
# not depend on copying a long prompt out of chat history.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${INVOKER_BABYSIT_RUNNER:-$ROOT/run.sh}"
WORK_DIR="${INVOKER_BABYSIT_PLAN_DIR:-${TMPDIR:-/tmp}/invoker-admin-bypass-babysit}"
REPO_URL="${INVOKER_BABYSIT_REPO_URL:-$(git -C "$ROOT" remote get-url origin 2>/dev/null || echo git@github.com:Neko-Catpital-Labs/Invoker.git)}"
BASE_BRANCH="${INVOKER_BABYSIT_BASE_BRANCH:-master}"
POOL_ID="${INVOKER_BABYSIT_POOL_ID:-remote_digital_ocean_1}"
NO_TRACK=1
DRY_RUN=0
PRINT_PROMPT=0
PRINT_PLAN=0
OUTPUT_PLAN=""

usage() {
  cat <<'USAGE'
Usage: scripts/submit-admin-bypass-accountability-loop.sh [options]

Generate and submit an Invoker plan for the admin-bypass accountability babysit
loop. By default, the plan is submitted with `./run.sh --headless run --no-track`.

Options:
  --base-branch <branch>   Base branch for the generated Invoker plan.
  --dry-run                Write the generated plan path and do not submit.
  --output <path>          Write the generated plan to this path.
  --pool-id <pool>         Pool ID for the babysit task.
  --print-plan             Print the generated plan to stdout and do not submit.
  --print-prompt           Print only the embedded prompt to stdout and exit.
  --repo-url <url>         Repo URL for the generated Invoker plan.
  --track                  Submit without --no-track.
  --no-track               Submit with --no-track. This is the default.
  -h, --help               Show this help.

Environment overrides:
  INVOKER_BABYSIT_BASE_BRANCH
  INVOKER_BABYSIT_PLAN_DIR
  INVOKER_BABYSIT_POOL_ID
  INVOKER_BABYSIT_REPO_URL
  INVOKER_BABYSIT_RUNNER
USAGE
}

yaml_quote() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
print('"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"')
PY
}

write_prompt() {
  cat <<'PROMPT'
Goal: Own the admin-bypass landing loop end-to-end until every live admin-bypass/dequeued PR is in exactly one proven terminal or active state: landed, queued by Mergify, actively running/queued in Invoker for a worker-fixable blocker, or posted once with an exact human-only blocker.

Motivation: I should not need to manually troubleshoot admin-bypass PRs. The worker must prove that every queue-able or worker-fixable PR is actually loaded into the execution system, not merely marked in a ledger.

Instructions:
- Start from no prior context.
- Follow LOOP.md exactly.
- Run `bash ./loop-driver.sh --skip-battle` first to regenerate the live target set and ledger failure summary.
- Gather live evidence from:
  - `gh pr view`
  - GitHub GraphQL reviewThreads
  - Mergify comments/checks
  - admin-bypass ledger JSONL
  - Invoker queue state
  - recent repair transcripts/plans
- Build a per-PR table for every live `admin-bypass` or `dequeued` PR:
  - PR number
  - stack position, especially bottom-of-stack
  - current blocker
  - whether blocker is worker-fixable or human-only
  - whether Mergify can queue it now
  - whether Invoker has a matching running/queued repair or safe-push task
  - exact evidence proving the state

Critical invariant:
- A PR is not handled just because the ledger says `repair-delegated`.
- If a PR has a worker-fixable blocker and no matching active Invoker task or queued safe-push exists for the current head SHA and blocker key, treat that as a worker bug.
- Fix the worker/repro code so the PR is loaded into Invoker automatically, then rerun the worker and prove the real PR task exists.
- Preserve the existing Git handoff safety check: if a completed repair task records a `commitHash`, prove from a fresh clone/fetch that the recorded commit is reachable from the branch remote and that the remote task branch resolves to that commit before dependent tasks rely on it.
- If a dependent task fails with `fatal: invalid reference: <40-char sha>`, treat it as an unpublished or unreachable upstream commit until fresh fetch evidence proves otherwise.

Prioritization:
- Always inspect bottom-of-stack PRs first.
- Do not let upper-stack conflicts or later PR blockers prevent bottom PR repair/requeue.
- For CodeRabbit-only unresolved review threads, the admin-bypass worker must classify them as worker-fixable bot-review-thread blockers and submit a repair task.
- Outdated bot threads should not block queueing unless GitHub/Mergify still treats them as unresolved required review threads.
- Human review threads must get one exact human-only blocker comment and stop retrying.

Allowed actions:
- Edit only worker logic, repros, tests, executor-publication code, infra-repair classification code, or prompt templates required for the current failure mode.
- Rerun `bash ./loop-driver.sh`.
- Rerun the real worker after each worker-owned fix.
- Create/submit Invoker tasks through the worker path.

Forbidden actions:
- Do not manually edit, queue, relabel, rebase, split, merge, or force-push target PRs.
- Do not count manual cleanup as success.
- Do not make unrelated refactors or broad queue-policy rewrites.
- Do not treat repeated recreate/retry as success.

Acceptance criteria:
- `bash ./loop-driver.sh` exits 0 after each worker-owned fix.
- Every live admin-bypass/dequeued PR is accounted for in one of:
  - landed,
  - queued by Mergify,
  - active/running/queued Invoker repair or safe-push task for the current head SHA,
  - exact human-only blocker posted once.
- Any ledger-delegated PR without a matching active Invoker task is fixed as a worker bug.
- Every completed repair task's recorded `commitHash` is reachable from a fresh clone/fetch of the branch remote before dependent tasks start from it.
- The remote task branch resolves exactly to the recorded repair commit after publication.
- The real worker is rerun after each worker-owned fix.
- The final report names all remaining PRs, their state, and the exact evidence.
- The final result shows worker-caused progress on real PRs, not manual PR edits.
PROMPT
}

write_plan() {
  local repo_url_quoted base_branch_quoted pool_id_quoted
  repo_url_quoted="$(yaml_quote "$REPO_URL")"
  base_branch_quoted="$(yaml_quote "$BASE_BRANCH")"
  pool_id_quoted="$(yaml_quote "$POOL_ID")"

  cat <<YAML
name: "Admin-bypass accountability babysit loop"
description: |
  Continue the admin-bypass/dequeued babysit worker loop with an explicit
  accountability check: every worker-fixable PR must have a matching active
  Invoker repair or safe-push task for the current head and blocker key.
repoUrl: $repo_url_quoted
baseBranch: $base_branch_quoted
onFinish: pull_request
mergeMode: external_review
tasks:
  - id: admin-bypass-accountability-loop
    description: |
      Own the live admin-bypass/dequeued landing loop end-to-end. Do not count
      ledger-only repair delegation as handled unless a matching active Invoker
      task or safe-push exists for the same head SHA and blocker key.
    prompt: |
YAML
  write_prompt | sed 's/^/      /'
  cat <<YAML
    poolId: $pool_id_quoted
    dependencies: []
YAML
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-branch)
      BASE_BRANCH="${2:?--base-branch requires a value}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --output)
      OUTPUT_PLAN="${2:?--output requires a value}"
      shift 2
      ;;
    --pool-id)
      POOL_ID="${2:?--pool-id requires a value}"
      shift 2
      ;;
    --print-plan)
      PRINT_PLAN=1
      shift
      ;;
    --print-prompt)
      PRINT_PROMPT=1
      shift
      ;;
    --repo-url)
      REPO_URL="${2:?--repo-url requires a value}"
      shift 2
      ;;
    --track)
      NO_TRACK=0
      shift
      ;;
    --no-track)
      NO_TRACK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PRINT_PROMPT" == "1" ]]; then
  write_prompt
  exit 0
fi

if [[ "$PRINT_PLAN" == "1" ]]; then
  write_plan
  exit 0
fi

mkdir -p "$WORK_DIR"
if [[ -n "$OUTPUT_PLAN" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PLAN")"
fi
if [[ -z "$OUTPUT_PLAN" ]]; then
  OUTPUT_PLAN="$(mktemp "$WORK_DIR/admin-bypass-accountability-loop.XXXXXX.yaml")"
fi

write_plan > "$OUTPUT_PLAN"
echo "[admin-bypass-accountability-loop] wrote plan: $OUTPUT_PLAN"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[admin-bypass-accountability-loop] dry run: not submitting"
  exit 0
fi

if [[ "$NO_TRACK" == "1" ]]; then
  exec "$RUNNER" --headless run "$OUTPUT_PLAN" --no-track
fi

exec "$RUNNER" --headless run "$OUTPUT_PLAN"
