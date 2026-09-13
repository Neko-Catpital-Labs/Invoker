#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-target-repos.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$FAKE_GH_STATE_DIR/state.json"

GH_LOG="$TMP/gh-calls.log"; : > "$GH_LOG"
cat > "$TMP/bin/gh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_LOG"
exec "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "\$@" </dev/null
EOF
chmod +x "$TMP/bin/gh"

NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

RG_LOG="$TMP/review-gate.log"; : > "$RG_LOG"
cat > "$TMP/review-gate.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "$RG_LOG"
printf '{}\n'
EOF
chmod +x "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_GITHUB_TARGET_REPOS="fake/repo,other/tools" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" </dev/null 2>&1
}

out="$(run_cron)" || fail "tick exited non-zero" "$out"

grep -q "^pr list --repo fake/repo " "$GH_LOG" || fail "primary repo was not scanned" "$(cat "$GH_LOG")"
grep -q "^pr list --repo other/tools " "$GH_LOG" || fail "second configured repo was not scanned" "$(cat "$GH_LOG")"

primary_plan="$TMP/plans/repair-pr-801.yaml"
other_plan="$TMP/plans/other__tools/repair-pr-801.yaml"
[ -f "$primary_plan" ] || fail "primary repo plan missing" "$out"
[ -f "$other_plan" ] || fail "second repo plan missing" "$out"
grep -qx 'repoUrl: https://github.com/fake/repo.git' "$primary_plan" \
  || fail "primary plan must target fake/repo" "$(cat "$primary_plan")"
grep -qx 'repoUrl: https://github.com/other/tools.git' "$other_plan" \
  || fail "second plan must target other/tools" "$(cat "$other_plan")"
grep -q "key='other/tools#801'" "$other_plan" \
  || fail "second repo ledger key must carry the repo" "$(cat "$other_plan")"

runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 4 ] || fail "expected 2 submissions per repo (801 and 803), got $runs" "$(cat "$NODE_LOG")"

lookups="$(wc -l < "$RG_LOG" | tr -d ' ')"
[ "$lookups" -eq 2 ] || fail "only the primary repo's broken PRs may hit review-gate; got $lookups lookups" "$(cat "$RG_LOG")"

out="$(run_cron)" || fail "second tick exited non-zero" "$out"
runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 4 ] || fail "second tick must dedup both repos; got $runs total submissions" "$out"

echo "[test] passed"
