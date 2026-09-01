#!/usr/bin/env bash
# Regression proof for unsupported present-tense green-baseline claims.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/unsupported-green.yaml" <<'YAML'
name: unsupported-green-baseline
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/example/repo.git
description: |
  Goal: The existing test baseline is green.
  Motivation: Keep the implementation safe.
  Safety invariant: Do not weaken the test suite.
  Verify: pnpm test
tasks:
  - id: future-verification
    description: |
      Goal: The existing test baseline is green.
      Motivation: Keep the implementation safe.
      Safety invariant: Do not weaken the test suite.
      Effectiveness measurement: The focused test command exits 0.
    command: pnpm test
YAML

output=""
checker_rc=0
output="$(bash "$CHECKER" "$TMP_DIR/unsupported-green.yaml" 2>&1)" || checker_rc=$?
printf '%s\n' "$output"
if [[ "$checker_rc" -eq 0 ]]; then
  echo "FAIL: unsupported present-tense green-baseline claim passed completeness" >&2
  exit 1
fi
echo "PASS: unsupported present-tense green-baseline claim was rejected"

now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
run_case() {
  local name="$1" expected="$2" description="$3" evidence="${4:-}"
  local file="$TMP_DIR/$name.yaml" actual=0
  {
    printf 'name: %s\nonFinish: pull_request\nmergeMode: manual\nrepoUrl: https://github.com/example/repo.git\n' "$name"
    printf 'baseCommitSha: abc123\ndescription: |\n  Goal: Check the baseline.\n  Motivation: Keep planning honest.\n  Safety invariant: Do not claim unexecuted results.\n  Verify: pnpm test\n  %s\ntasks:\n  - id: check\n    description: |\n      Goal: Check the baseline.\n      Motivation: Keep planning honest.\n      Safety invariant: Do not claim unexecuted results.\n      Effectiveness measurement: The focused command reports its result.\n    command: pnpm test\n' "$description"
    if [[ -n "$evidence" ]]; then printf '%b\n' "$evidence"; fi
  } > "$file"
  bash "$CHECKER" "$file" >/dev/null 2>&1 || actual=$?
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL: $name expected checker exit $expected, got $actual" >&2
    exit 1
  fi
  echo "PASS: $name"
}

run_case fresh-commit-bound 0 'The baseline is green.' "verificationEvidence:\n  - kind: deterministic_command\n    status: passed\n    commitSha: abc123\n    recordedAt: $now\n    command: pnpm test\n    exitCode: 0\n    output: 'Tests passed'"
run_case unverified-wording 0 'UNVERIFIED: The baseline is green.'
run_case baseline-repair-dependency 0 'A baseline-repair dependency must run before the green baseline can be verified.'
run_case ordinary-post-change-intent 0 'Keep the suite green after the change.'
run_case missing-evidence 1 'The baseline is green.'
run_case expired-evidence 1 'The baseline is green.' "verificationEvidence:\n  - kind: deterministic_command\n    status: passed\n    commitSha: abc123\n    recordedAt: 2020-01-01T00:00:00.000Z\n    command: pnpm test\n    exitCode: 0\n    output: 'Tests passed'"
run_case failed-evidence 1 'The baseline is green.' "verificationEvidence:\n  - kind: deterministic_command\n    status: failed\n    commitSha: abc123\n    recordedAt: $now\n    command: pnpm test\n    exitCode: 1\n    output: 'Tests failed'"
run_case wrong-commit-evidence 1 'The baseline is green.' "verificationEvidence:\n  - kind: deterministic_command\n    status: passed\n    commitSha: wrong999\n    recordedAt: $now\n    command: pnpm test\n    exitCode: 0\n    output: 'Tests passed'"
run_case empty-output-evidence 1 'The baseline is green.' "verificationEvidence:\n  - kind: deterministic_command\n    status: passed\n    commitSha: abc123\n    recordedAt: $now\n    command: pnpm test\n    exitCode: 0\n    output: ''"
run_case pseudo-evidence 1 'The baseline is green.' 'evidence: "Tests passed"'

echo "PASS: baseline evidence fixture matrix"
