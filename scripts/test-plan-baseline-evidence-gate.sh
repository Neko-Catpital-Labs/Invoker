#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$ROOT/skills/plan-to-invoker/scripts/check-planning-completeness.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/mixed-present-future.yaml" <<'YAML'
name: mixed-present-future
onFinish: pull_request
mergeMode: manual
repoUrl: https://github.com/example/repo.git
description: |
  Goal: Preserve the current test baseline.
  Motivation: Keep the implementation safe.
  Safety invariant: Do not weaken the test suite.
  The existing test baseline is green, and we will verify it with `pnpm test`.
tasks:
  - id: future-verification
    description: |
      Goal: Verify the baseline.
      Motivation: Establish current evidence.
      Safety invariant: Do not claim unexecuted results.
      Effectiveness measurement: The command reports its result.
    command: pnpm test
YAML

actual=0
bash "$CHECKER" "$TMP_DIR/mixed-present-future.yaml" > "$TMP_DIR/output" 2>&1 || actual=$?
cat "$TMP_DIR/output"
if [[ "$actual" -eq 0 ]]; then
  echo "FAIL: mixed present-tense/future-intent baseline claim was accepted" >&2
  exit 1
fi
echo "PASS: mixed present-tense/future-intent baseline claim was rejected"

sed 's/The existing test baseline is green, and we will verify it with `pnpm test`\./Keep the test suite green after the change./' \
  "$TMP_DIR/mixed-present-future.yaml" > "$TMP_DIR/future-only.yaml"
bash "$CHECKER" "$TMP_DIR/future-only.yaml" >/dev/null
echo "PASS: future-only post-change intent remained accepted"
