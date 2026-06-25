#!/usr/bin/env bash
# Dedup proof for Job 1 (scripts/cron-coderabbit-address.sh):
#   1. a PR with a coderabbitai[bot] comment updated at T -> "would launch omp ... at T"
#   2. once T is in the ledger -> "no new CodeRabbit comments since T; skip"
#   3. a newer comment T2 -> "would launch omp ... at T2" again
#   4. once the per-PR attempt cap is reached -> "hit cap"
#
# Runs fully offline in dry-run with a fake `gh` serving captured comment JSON;
# touches only a temp ledger/lock.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

LEDGER="$TMP/ledger.tsv"; : > "$LEDGER"

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
case "${1:-}" in
  pr)
    if [ "${2:-}" = "list" ]; then
      printf '%s\n' '[{"number":777,"url":"https://github.com/owner/repo/pull/777","headRefName":"h","baseRefName":"main","title":"t"}]'
      exit 0
    fi
    ;;
  api)
    case "${2:-}" in
      */pulls/*/comments)
        printf '[{"user":{"login":"coderabbitai[bot]"},"body":"please fix X","updated_at":"%s","path":"a.ts","html_url":"u"}]\n' "${INVOKER_TEST_CR_UPDATED:?}"
        exit 0 ;;
      */issues/*/comments)
        printf '[]\n'; exit 0 ;;
    esac
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
export INVOKER_PR_CRON_DRY_RUN=1
export INVOKER_PR_CODERABBIT_STATE_FILE="$LEDGER"
export INVOKER_PR_CRON_LOCK="$TMP/crons.lock"

run() { bash scripts/cron-coderabbit-address.sh 2>&1; }

T1="2026-06-25T08:00:00Z"
T2="2026-06-25T09:30:00Z"
T3="2026-06-25T11:45:00Z"

# Check 1: new feedback at T1 -> would launch omp.
out="$(INVOKER_TEST_CR_UPDATED="$T1" run)"
echo "$out" | grep -q "would launch omp for new CodeRabbit activity at $T1" \
  || fail "check 1: expected 'would launch omp ... at $T1'" "$out"

# Record marker T1, as a successful omp run would.
printf 'coderabbit\t777\t%s\t%s\n' "$T1" "$(date +%s)" >> "$LEDGER"

# Check 2: same latest T1 -> skip.
out="$(INVOKER_TEST_CR_UPDATED="$T1" run)"
echo "$out" | grep -q "no new CodeRabbit comments since $T1; skip" \
  || fail "check 2: expected 'no new CodeRabbit comments since $T1; skip'" "$out"

# Check 3: newer T2 -> would launch again.
out="$(INVOKER_TEST_CR_UPDATED="$T2" run)"
echo "$out" | grep -q "would launch omp for new CodeRabbit activity at $T2" \
  || fail "check 3: expected 'would launch omp ... at $T2'" "$out"

# Check 4: reach the per-PR cap (3 records), newer T3 -> hit cap.
printf 'coderabbit\t777\t%s\t%s\n' "$T2" "$(date +%s)" >> "$LEDGER"
printf 'coderabbit\t777\t%s\t%s\n' "2026-06-25T07:00:00Z" "$(date +%s)" >> "$LEDGER"
out="$(INVOKER_TEST_CR_UPDATED="$T3" run)"
echo "$out" | grep -q "hit cap" \
  || fail "check 4: expected 'hit cap' at the per-PR attempt cap" "$out"

echo "[repro] passed"
