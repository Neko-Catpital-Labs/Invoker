#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-plan-repo-url.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
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
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" 2>&1
)" || fail "tick exited non-zero" "$out"

plan="$TMP/plans/repair-pr-801.yaml"
[ -f "$plan" ] || fail "plan file missing at $plan" "$out"
repo_lines="$(grep -c '^repoUrl: ' "$plan" || true)"
[ "$repo_lines" -eq 1 ] || fail "plan must carry exactly one top-level repoUrl; got $repo_lines" "$(cat "$plan")"
grep -qx 'repoUrl: https://github.com/fake/repo.git' "$plan" \
  || fail "plan repoUrl must point at the PR's own repo" "$(cat "$plan")"

echo "[test] passed"
