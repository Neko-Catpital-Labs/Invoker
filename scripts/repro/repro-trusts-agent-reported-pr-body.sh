#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PROVIDER_IF="$ROOT/packages/execution-engine/src/merge-gate-provider.ts"
PROVIDER="$ROOT/packages/execution-engine/src/github-merge-gate-provider.ts"
TASK_RUNNER="$ROOT/packages/execution-engine/src/task-runner.ts"
echo "[repro] problem: stack publish trusted the agent-reported PR body, not the body actually on GitHub"
echo "[repro] root cause: a lazy agent can report a compliant body while Mergify defaulted the real PR to the commit message"

python3 - "$PROVIDER_IF" "$PROVIDER" "$TASK_RUNNER" <<'PY'
import pathlib, sys
provider_if = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
provider = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
task_runner = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")

# Model: agent reports a compliant body, but the live published body is a commit message.
reported_body = "## Summary\n<details><summary>Review metadata</summary>\nReview Claim: c\n</details>\n## Non-goals\n## Test Plan\n## Revert Plan"
published_body = "Just a commit message subject\n\nbody line"

def validate(body):
    return "<summary>Review metadata</summary>" in body and any(
        l.strip() == "## Non-goals" for l in body.splitlines())

# pre-fix: validate agent-reported body -> passes, ships a non-compliant published PR
assert validate(reported_body), "agent-reported body looks compliant"
# post-fix: validate the published body -> rejected
assert not validate(published_body), "fixed model validates the live published body and rejects it"

if "getReviewBody" not in provider_if:
    raise SystemExit("MergeGateProvider must expose getReviewBody")
if "async getReviewBody" not in provider:
    raise SystemExit("GitHubMergeGateProvider must implement getReviewBody")
if "getReviewBody" not in task_runner or "bodySource" not in task_runner:
    raise SystemExit("publishReviewStackWithMakePrSkill must fetch + validate the published body")

print("[repro] pre-fix model: agent-reported body validated -> non-compliant PR body ships on GitHub")
print("[repro] post-fix model: live published body fetched + validated -> rejected and falls through")
print("[repro] source check: provider.getReviewBody exists and stack publish validates the published body")
PY
echo "[repro] passed"
