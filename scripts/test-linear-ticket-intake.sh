#!/usr/bin/env bash
# Behavior test for scripts/linear-ticket-intake.sh with Linear + submit stubbed.
#
# Covers:
#   A. Gaps: missing Verify → needs-input comment, no submit
#   B. Complete ticket → dry-run would submit after completeness
#   C. Resubmit guard skips a recently submitted issue
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKER="$REPO_ROOT/scripts/linear-ticket-intake.sh"
SANDBOXES=()
cleanup() {
  local d
  for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do rm -rf "$d"; done
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "----- log -----" >&2; cat "$2" >&2; }; exit 1; }

run_case() {
  local name="$1"
  sb="$(mktemp -d "${TMPDIR:-/tmp}/test-linear-intake.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/bin" "$sb/work"
  calls="$sb/actions.jsonl"
  : > "$calls"

  cat > "$sb/bin/comment-stub" <<'STUB'
#!/usr/bin/env bash
echo "$(cat)" >> "$CALLS"
STUB
  sed -i.bak "s|\$CALLS|$calls|g" "$sb/bin/comment-stub" 2>/dev/null || \
    sed -i '' "s|\$CALLS|$calls|g" "$sb/bin/comment-stub"
  # Rewrite stub without sed portability issues
  cat > "$sb/bin/comment-stub" <<STUB
#!/usr/bin/env bash
cat >> "$calls"
echo >> "$calls"
STUB
  chmod +x "$sb/bin/comment-stub"

  cat > "$sb/bin/submit-stub" <<STUB
#!/usr/bin/env bash
echo "\$1" >> "$sb/submit-calls"
exit 0
STUB
  chmod +x "$sb/bin/submit-stub"

  log="$sb/worker.log"
}

# ── A. Gaps: no Verify ───────────────────────────────────────────────────────
run_case A
cat > "$sb/issues.json" <<'JSON'
[
  {
    "id": "issue-gap",
    "identifier": "INV-1",
    "title": "null deref in plan-parser",
    "description": "Repo: https://github.com/Neko-Catpital-Labs/Invoker.git\nFiles: packages/app/src/plan-parser.ts\n",
    "labels": { "nodes": [{ "name": "invoker-ready" }] }
  }
]
JSON
env \
  INVOKER_LINEAR_FIXTURE_ISSUES="$sb/issues.json" \
  INVOKER_LINEAR_WORK_DIR="$sb/work" \
  INVOKER_LINEAR_COMMENT_CMD="$sb/bin/comment-stub" \
  INVOKER_LINEAR_SUBMIT_CMD="$sb/bin/submit-stub" \
  INVOKER_LINEAR_DRY_RUN=0 \
  bash "$WORKER" > "$log" 2>&1 || true

grep -q "INV-1: .*gap" "$log" || fail "A: expected gap log for INV-1" "$log"
grep -q "invoker-needs-input" "$calls" || fail "A: expected needs-input label in comment action" "$calls"
test ! -f "$sb/submit-calls" || fail "A: must not submit on gaps" "$log"
echo "PASS A: gaps comment, no submit"

# ── B. Complete ticket dry-run ───────────────────────────────────────────────
run_case B
cat > "$sb/issues.json" <<'JSON'
[
  {
    "id": "issue-ok",
    "identifier": "INV-2",
    "title": "null deref in plan-parser when YAML lacks name",
    "description": "Repo: https://github.com/Neko-Catpital-Labs/Invoker.git\nVerify: test 1 -eq 1\nFiles: packages/app/src/plan-parser.ts\nMotivation: Crashes plan parse for empty name.\n",
    "labels": { "nodes": [{ "name": "invoker-ready" }] }
  }
]
JSON
env \
  INVOKER_LINEAR_FIXTURE_ISSUES="$sb/issues.json" \
  INVOKER_LINEAR_WORK_DIR="$sb/work" \
  INVOKER_LINEAR_COMMENT_CMD="$sb/bin/comment-stub" \
  INVOKER_LINEAR_SUBMIT_CMD="$sb/bin/submit-stub" \
  INVOKER_LINEAR_DRY_RUN=1 \
  bash "$WORKER" > "$log" 2>&1 || fail "B: worker exited non-zero" "$log"

grep -q "INV-2: would submit" "$log" || fail "B: expected dry-run submit" "$log"
test ! -f "$sb/submit-calls" || fail "B: dry-run must not call submit" "$log"
echo "PASS B: complete ticket dry-run would submit"

# ── C. Resubmit guard ────────────────────────────────────────────────────────
run_case C
cat > "$sb/issues.json" <<'JSON'
[
  {
    "id": "issue-ok",
    "identifier": "INV-3",
    "title": "null deref in plan-parser when YAML lacks name",
    "description": "Repo: https://github.com/Neko-Catpital-Labs/Invoker.git\nVerify: test 1 -eq 1\nFiles: packages/app/src/plan-parser.ts\n",
    "labels": { "nodes": [{ "name": "invoker-ready" }] }
  }
]
JSON
mkdir -p "$sb/work"
: > "$sb/work/submitted-inv-3"
env \
  INVOKER_LINEAR_FIXTURE_ISSUES="$sb/issues.json" \
  INVOKER_LINEAR_WORK_DIR="$sb/work" \
  INVOKER_LINEAR_COMMENT_CMD="$sb/bin/comment-stub" \
  INVOKER_LINEAR_SUBMIT_CMD="$sb/bin/submit-stub" \
  INVOKER_LINEAR_DRY_RUN=1 \
  INVOKER_LINEAR_RESUBMIT_GUARD_MIN=1200 \
  bash "$WORKER" > "$log" 2>&1 || fail "C: worker exited non-zero" "$log"

grep -q "INV-3: resubmit guard" "$log" || fail "C: expected resubmit guard skip" "$log"
echo "PASS C: resubmit guard"

echo "PASS: linear-ticket-intake.sh behavior verified (gaps, dry-run submit, resubmit-guard)"
