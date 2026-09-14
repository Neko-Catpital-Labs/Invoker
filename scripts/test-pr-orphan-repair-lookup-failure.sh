#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-lookup-failure.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin"
ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

run_case() {
  local name="$1" gate_body="$2" expected_log="$3"
  local dir="$TMP/$name"
  mkdir -p "$dir/state" "$dir/home" "$dir/plans"
  cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$dir/state/state.json"
  : > "$NODE_LOG"
  printf '#!/usr/bin/env bash\n%s\n' "$gate_body" > "$dir/review-gate.sh"
  chmod +x "$dir/review-gate.sh"

  local out
  out="$(
    PATH="$TMP/bin:$PATH" \
    HOME="$dir/home" \
    FAKE_GH_STATE_DIR="$dir/state" \
    INVOKER_GITHUB_TARGET_REPO="fake/repo" \
    INVOKER_PR_CRON_AUTHOR="fake-bot" \
    INVOKER_PR_CRON_LOCK="$dir/crons.lock" \
    INVOKER_PR_CRON_REVIEW_GATE_CMD="$dir/review-gate.sh" \
    INVOKER_PR_ORPHAN_STATE_FILE="$dir/ledger.tsv" \
    INVOKER_PR_ORPHAN_PLAN_DIR="$dir/plans" \
    bash "$ROOT/scripts/cron-pr-orphan-repair.sh" 2>&1
  )" || fail "$name: tick exited non-zero" "$out"

  echo "$out" | grep -q "PR #801: $expected_log" \
    || fail "$name: expected the lookup problem to be logged as a skip" "$out"
  local runs
  runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
  [ "$runs" -eq 0 ] || fail "$name: a PR whose lookup failed must not get a repair task; got $runs" "$(cat "$NODE_LOG")"
  [ ! -e "$dir/plans/repair-pr-801.yaml" ] || fail "$name: no plan may be written for a PR whose lookup failed"
  echo "[test] $name: skipped"
}

run_case nonzero-exit \
  'echo "Live owner is present but did not serve cli-query" >&2; exit 1' \
  "workflow lookup failed; skipping"
run_case zero-exit-malformed-json \
  "printf 'Live owner is present but did not serve cli-query\\n'; exit 0" \
  "workflow lookup returned an invalid record; skipping"
run_case zero-exit-empty-output \
  'exit 0' \
  "workflow lookup returned an invalid record; skipping"
run_case zero-exit-non-object \
  "printf 'null\\n'; exit 0" \
  "workflow lookup returned an invalid record; skipping"

echo "[test] passed"
