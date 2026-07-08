#!/usr/bin/env bash
# Test scripts/install-daily-e2e-do-cron.sh + uninstall against an isolated fake
# `crontab` (a temp store), never the real user crontab:
#   - install writes the marker, the 0 6,18 * * * schedule, and the worker path
#   - install is idempotent (re-run keeps exactly one line)
#   - uninstall removes it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-daily-e2e-do-cron.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && { echo "----- crontab -----"; echo "$2"; }; exit 1; }

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

MARKER="# invoker-cron-daily-e2e-do"
cron_now() { crontab -l 2>/dev/null || true; }

bash scripts/install-daily-e2e-do-cron.sh >/dev/null

cr="$(cron_now)"
echo "$cr" | grep -F "$MARKER" | grep -q "scripts/daily-e2e-do-submit.sh" \
  || fail "marker/worker missing" "$cr"
echo "$cr" | grep -F "$MARKER" | grep -q '^0 6,18 \* \* \*' \
  || fail "line missing '0 6,18 * * *' schedule" "$cr"

count="$(cron_now | grep -c 'invoker-cron-daily-e2e-do' || true)"
[ "$count" -eq 1 ] || fail "expected 1 cron line, found $count" "$(cron_now)"

# Idempotency.
bash scripts/install-daily-e2e-do-cron.sh >/dev/null
count="$(cron_now | grep -c 'invoker-cron-daily-e2e-do' || true)"
[ "$count" -eq 1 ] || fail "after re-install expected 1 cron line, found $count" "$(cron_now)"

# Uninstall removes it.
bash scripts/uninstall-daily-e2e-do-cron.sh >/dev/null
count="$(cron_now | grep -c 'invoker-cron-daily-e2e-do' || true)"
[ "$count" -eq 0 ] || fail "after uninstall expected 0 cron lines, found $count" "$(cron_now)"

echo "[test] passed"
