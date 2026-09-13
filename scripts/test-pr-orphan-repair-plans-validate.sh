#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ORIGINAL_PATH="$PATH"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-plans-validate.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq is required"

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
  PATH="$TMP/bin:$ORIGINAL_PATH" \
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

mapfile -t plans < <(find "$TMP/plans" -type f -name '*.yaml' | sort)
[ "${#plans[@]}" -ge 2 ] || fail "expected at least 2 generated plans, got ${#plans[@]}" "$out"

for plan in "${plans[@]}"; do
  if output="$(PATH="$ORIGINAL_PATH" bash "$ROOT/skills/plan-to-invoker/scripts/validate-plan.sh" "$plan" 2>&1)"; then
    printf '%s\n' "$output" | jq -e . >/dev/null 2>&1 \
      || fail "validator output was not valid JSON for $plan" "$output"
    continue
  fi

  printf '%s\n' "$output" | jq -e 'type == "array"' >/dev/null 2>&1 \
    || fail "validator output was not a valid JSON error array for $plan" "$output"

  if ! unexpected="$(printf '%s\n' "$output" \
    | jq -c '[.[] | select(.errorType != "non_portable_pipefail")]' 2>&1)"; then
    fail "validator output was not valid JSON for $plan" "$output"
  fi

  if [ "$(printf '%s\n' "$unexpected" | jq 'length')" -ne 0 ]; then
    fail "plan has unexpected validator errors: $plan" "$(printf '%s\n' '----- plan -----'; cat "$plan"; printf '\n%s\n%s\n' '----- validator output -----' "$output")"
  fi
done

echo "[test] passed"
