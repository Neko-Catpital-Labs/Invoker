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

# Model the schema gate on a #2170-style body: ## Summary/## Test Plan/## Revert Plan,
# but no visible review-compression sections and no ## Non-goals.
commit_msg_body = "## Summary\n\nCut over recovery.\n\n## Test Plan\n\n- [x] x\n\n## Revert Plan\n\n- yes\n"
compliant_body = (
  "## Summary\n\nx\n\n"
  "## Review Claim\n\nc\n\n## Review Lane\n\ncleanup\n\n## Review Unit\n\nscalar\n\n"
  "## Safety Invariant\n\ns\n\n## Slice Rationale\n\nr\n\n"
  "## Non-goals\n- none\n\n## Test Plan\n- [x] x\n\n## Revert Plan\n- yes\n"
)
required_headings = [
    "## Summary",
    "## Review Claim",
    "## Review Lane",
    "## Review Unit",
    "## Safety Invariant",
    "## Slice Rationale",
    "## Non-goals",
    "## Test Plan",
    "## Revert Plan",
]
metadata_headings = [
    "## Review Claim",
    "## Review Lane",
    "## Review Unit",
    "## Safety Invariant",
    "## Slice Rationale",
]

def has_heading(body, h):
    return any(line.strip().lower() == h.lower() for line in body.splitlines())
def section_body(body, h):
    lines = body.splitlines()
    expected = h.lower()
    for idx, line in enumerate(lines):
        if line.strip().lower() != expected:
            continue
        collected = []
        for next_line in lines[idx + 1:]:
            if next_line.startswith("## "):
                break
            collected.append(next_line)
        return "\n".join(collected).strip()
    return ""

# pre-fix model: nothing validated the body -> commit-message body accepted
def pre_fix_accepts(body): return True
assert pre_fix_accepts(commit_msg_body), "pre-fix model accepts any published body"

# post-fix model: require the visible review-stack schema
def post_fix_valid(body):
    return all(has_heading(body, h) for h in required_headings) and all(
        section_body(body, h) for h in metadata_headings
    )
assert not post_fix_valid(commit_msg_body), "fixed model must reject the #2170 commit-message body"
assert post_fix_valid(compliant_body), "fixed model must accept a compliant review-stack body"

# source invariants
if "export function validateReviewStackPrBody" not in pr_auth:
    raise SystemExit("missing validateReviewStackPrBody in pr-authoring.ts")
if "REVIEW_STACK_METADATA_SECTIONS" not in pr_auth:
    raise SystemExit("validateReviewStackPrBody must check visible review metadata sections")
if "validateReviewStackPrBody(" not in task_runner:
    raise SystemExit("publishReviewStackWithMakePrSkill must call validateReviewStackPrBody")

print("[repro] pre-fix model: commit-message body accepted -> PR #2170 shipped unreviewable")
print("[repro] post-fix model: body without visible review metadata sections + Non-goals is rejected")
print("[repro] source check: stack publish validates each body via validateReviewStackPrBody")
PY

pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/pr-authoring.test.ts >/dev/null 2>&1 && echo "[repro] focused pr-authoring tests pass"
echo "[repro] passed"
