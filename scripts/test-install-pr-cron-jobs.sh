#!/usr/bin/env bash
# Test scripts/install-pr-cron-jobs.sh + uninstall-pr-cron-jobs.sh against an
# isolated fake `crontab` (a temp store), never the real user crontab:
#   - install writes both markers, */5 schedule, correct worker paths
#   - install is idempotent (re-run keeps exactly two lines)
#   - uninstall removes both
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-pr-cron.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- crontab -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/home"
export CRONTAB_STORE="$TMP/crontab.txt"
cat > "$TMP/bin/crontab" <<'CT'
#!/usr/bin/env bash
store="${CRONTAB_STORE:?}"
case "${1:-}" in
  -l) [ -f "$store" ] && cat "$store" || { echo "no crontab for user" >&2; exit 1; } ;;
  -r) rm -f "$store" ;;
  "") cat > "$store" ;;
  *)  cp "$1" "$store" ;;
esac
CT
chmod +x "$TMP/bin/crontab"

export PATH="$TMP/bin:$PATH"
export HOME="$TMP/home"

bash scripts/install-pr-cron-jobs.sh >/dev/null

cron_now() { crontab -l 2>/dev/null || true; }

cr="$(cron_now)"
echo "$cr" | grep -F "# invoker-cron-coderabbit-address" | grep -q "scripts/cron-coderabbit-address.sh" \
  || fail "coderabbit marker/worker missing" "$cr"
echo "$cr" | grep -F "# invoker-cron-pr-conflict-rebase" | grep -q "scripts/cron-pr-conflict-rebase.sh" \
  || fail "conflict marker/worker missing" "$cr"
echo "$cr" | grep -F "# invoker-cron-coderabbit-address" | grep -q '^\*/5 \* \* \* \*' \
  || fail "coderabbit line missing */5 schedule" "$cr"
echo "$cr" | grep -F "# invoker-cron-pr-conflict-rebase" | grep -q '^\*/5 \* \* \* \*' \
  || fail "conflict line missing */5 schedule" "$cr"

count="$(cron_now | grep -c 'invoker-cron-' || true)"
[ "$count" -eq 2 ] || fail "expected 2 cron lines, found $count" "$(cron_now)"

# Idempotency: re-run, still exactly two.
bash scripts/install-pr-cron-jobs.sh >/dev/null
count="$(cron_now | grep -c 'invoker-cron-' || true)"
[ "$count" -eq 2 ] || fail "after re-install expected 2 cron lines, found $count" "$(cron_now)"

# Uninstall removes both.
bash scripts/uninstall-pr-cron-jobs.sh >/dev/null
count="$(cron_now | grep -c 'invoker-cron-' || true)"
[ "$count" -eq 0 ] || fail "after uninstall expected 0 cron lines, found $count" "$(cron_now)"

echo "[test] passed"
