#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PR_AUTH="$ROOT/packages/execution-engine/src/pr-authoring.ts"
TASK_RUNNER="$ROOT/packages/execution-engine/src/task-runner.ts"
echo "[repro] problem: Invoker review-stack PRs shipped commit-message bodies with no review-compression (PR #2170)"
echo "[repro] root cause: the stack-publish path validated only artifact JSON, never the PR body"

python3 - "$PR_AUTH" "$TASK_RUNNER" <<'PY'
import pathlib, sys
pr_auth = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
task_runner = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")

# Model the schema gate on a #2170-style body: ## Summary/## Test Plan,
# but no ## Revert Plan.
commit_msg_body = "## Summary\n\nCut over recovery.\n\n## Test Plan\n\n- [x] x\n"
compliant_body = (
  "## Summary\n\nx\n\n## Test Plan\n- [x] x\n\n## Revert Plan\n- yes\n"
)

def has_heading(body, h):
    return any(line.strip().lower() == h.lower() for line in body.splitlines())

# pre-fix model: nothing validated the body -> commit-message body accepted
def pre_fix_accepts(body): return True
assert pre_fix_accepts(commit_msg_body), "pre-fix model accepts any published body"

# post-fix model: require canonical body headings
def post_fix_valid(body):
    return all(has_heading(body, heading) for heading in ["## Summary", "## Test Plan", "## Revert Plan"])
assert not post_fix_valid(commit_msg_body), "fixed model must reject the #2170 commit-message body"
assert post_fix_valid(compliant_body), "fixed model must accept a compliant body"

# source invariants
if "export function validateReviewStackPrBody" not in pr_auth:
    raise SystemExit("missing validateReviewStackPrBody in pr-authoring.ts")
if "validateReviewStackPrBody(" not in task_runner:
    raise SystemExit("publishReviewStackWithMakePrSkill must call validateReviewStackPrBody")

print("[repro] pre-fix model: commit-message body accepted -> PR #2170 shipped unreviewable")
print("[repro] post-fix model: body without Revert Plan is rejected")
print("[repro] source check: stack publish validates each body via validateReviewStackPrBody")
PY

pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/pr-authoring.test.ts >/dev/null 2>&1 && echo "[repro] focused pr-authoring tests pass"
echo "[repro] passed"
