#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

EXPECTATION="fixed"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)
      EXPECTATION="bug"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    *)
      echo "usage: $0 [--expect-bug|--expect-fixed]" >&2
      exit 2
      ;;
  esac
done

TMP_ROOT="$(mktemp -d -t invoker-headless-query-hang-repro.XXXXXX)"

cleanup() {
  pkill -f "$TMP_ROOT/fake-electron.sh" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

FAKE_ELECTRON="$TMP_ROOT/fake-electron.sh"
cat > "$FAKE_ELECTRON" <<'SH'
#!/usr/bin/env bash
# Simulates a fresh Electron process whose IPC/owner handshake never
# resolves (owner crashed): ignores all args, blocks forever.
exec sleep 999999
SH
chmod +x "$FAKE_ELECTRON"

export INVOKER_HEADLESS_ELECTRON_BIN="$FAKE_ELECTRON"

if [[ "$EXPECTATION" == "bug" ]]; then
  echo "==> repro: guard disabled (INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS=0), outer bound=3s"
  set +e
  INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS=0 timeout -k 1 3 bash -c \
    "source '$ROOT_DIR/scripts/headless-lib.sh'; headless_query query workflows --output json" \
    > "$TMP_ROOT/out.log" 2>"$TMP_ROOT/err.log"
  OUTER_STATUS=$?
  set -e
  if [[ "$OUTER_STATUS" -eq 124 ]]; then
    echo "PASS: unguarded headless_query did not return within 3s (bug reproduced)"
    exit 0
  fi
  echo "FAIL: expected outer 3s bound to fire (status=$OUTER_STATUS)" >&2
  cat "$TMP_ROOT/out.log" "$TMP_ROOT/err.log" >&2 || true
  exit 1
fi

echo "==> repro: guard enabled (INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS=3)"
export INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS=3
source "$ROOT_DIR/scripts/headless-lib.sh"

START_SEC="$SECONDS"
set +e
headless_query query workflows --output json >"$TMP_ROOT/out.log" 2>"$TMP_ROOT/err.log"
STATUS=$?
set -e
ELAPSED=$((SECONDS - START_SEC))

if [[ "$STATUS" -ne 124 ]]; then
  echo "FAIL: expected exit 124, got $STATUS" >&2
  cat "$TMP_ROOT/out.log" "$TMP_ROOT/err.log" >&2 || true
  exit 1
fi
if [[ "$ELAPSED" -gt 6 ]]; then
  echo "FAIL: took ${ELAPSED}s, expected bounded near the 3s guard" >&2
  exit 1
fi
if ! grep -Fq "headless_query timed out after 3s" "$TMP_ROOT/err.log"; then
  echo "FAIL: expected clear timeout diagnostic on stderr" >&2
  cat "$TMP_ROOT/err.log" >&2
  exit 1
fi
echo "PASS: guarded headless_query returned within ${ELAPSED}s with exit 124 and a clear error"
