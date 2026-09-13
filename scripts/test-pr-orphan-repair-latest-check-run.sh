#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-latest-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/home" "$TMP/plans"

cat > "$TMP/prs.json" <<'JSON'
[
  {
    "number": 901, "title": "Cancelled run superseded by a passing rerun",
    "url": "https://github.com/fake/repo/pull/901", "isDraft": false,
    "baseRefName": "master", "headRefName": "feature/901",
    "headRefOid": "9010000000000000000000000000000000000000",
    "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": "", "labels": [],
    "statusCheckRollup": [
      {"__typename": "CheckRun", "name": "PR Body", "status": "COMPLETED", "conclusion": "CANCELLED",
       "startedAt": "2026-09-13T06:15:21Z", "completedAt": "2026-09-13T06:15:27Z"},
      {"__typename": "CheckRun", "name": "PR Body", "status": "COMPLETED", "conclusion": "SUCCESS",
       "startedAt": "2026-09-13T06:15:50Z", "completedAt": "2026-09-13T06:16:09Z"}
    ]
  },
  {
    "number": 902, "title": "Passing run followed by a failing rerun",
    "url": "https://github.com/fake/repo/pull/902", "isDraft": false,
    "baseRefName": "master", "headRefName": "feature/902",
    "headRefOid": "9020000000000000000000000000000000000000",
    "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED", "reviewDecision": "", "labels": [],
    "statusCheckRollup": [
      {"__typename": "CheckRun", "name": "PR Body", "status": "COMPLETED", "conclusion": "SUCCESS",
       "startedAt": "2026-09-13T06:15:21Z", "completedAt": "2026-09-13T06:15:40Z"},
      {"__typename": "CheckRun", "name": "PR Body", "status": "COMPLETED", "conclusion": "FAILURE",
       "startedAt": "2026-09-13T06:16:00Z", "completedAt": "2026-09-13T06:16:20Z"}
    ]
  }
]
JSON

cat > "$TMP/bin/gh" <<EOF
#!/usr/bin/env bash
if [ "\$1 \$2" = "pr list" ]; then cat "$TMP/prs.json"; exit 0; fi
exit 0
EOF
chmod +x "$TMP/bin/gh"

NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate.sh"

out="$(
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" </dev/null 2>&1
)" || fail "tick exited non-zero" "$out"

grep -q "repair-pr-901" "$NODE_LOG" \
  && fail "a check whose latest run passed must not trigger a repair" "$out"
grep -q "repair-pr-902" "$NODE_LOG" \
  || fail "a check whose latest run failed must still trigger a repair" "$out"

echo "[test] passed"
