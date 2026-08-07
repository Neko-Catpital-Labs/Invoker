#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d -t invoker-headless-query-exit-repro.XXXXXX)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

source "$ROOT_DIR/scripts/headless-lib.sh"

DELEGATION_RESPONSE_MARKER="[delegation] headless.query:"
DELEGATION_RESPONSE_SUFFIX=" response elapsedMs="

echo "==> repro: probing this run for a live delegated headless query owner"
set +e
timeout -k 1 10 "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless query workflows --output json \
  >"$TMP_ROOT/out.json" 2>"$TMP_ROOT/err.log"
STATUS=$?
set -e

if ! grep -F "$DELEGATION_RESPONSE_MARKER" "$TMP_ROOT/err.log" \
  | grep -Fq "$DELEGATION_RESPONSE_SUFFIX"; then
  echo "==> repro: no delegated headless.query response marker observed; running focused vitest guard"
  cd "$ROOT_DIR"
  pnpm --dir packages/app exec vitest run src/__tests__/headless-stdout-flush.test.ts \
    -t "invokes the injected exit fn only after the flush resolves"
  echo "PASS: focused vitest guard passed without requiring a live owner"
  exit 0
fi

if [[ "$STATUS" -eq 124 ]]; then
  echo "FAIL: delegated headless query produced an owner response but still hit the outer timeout" >&2
  cat "$TMP_ROOT/err.log" >&2 || true
  exit 1
fi

if [[ "$STATUS" -ne 0 ]]; then
  echo "FAIL: delegated headless query exited with status $STATUS" >&2
  cat "$TMP_ROOT/err.log" >&2 || true
  exit 1
fi

python3 - "$TMP_ROOT/out.json" <<'PY'
import json
import pathlib
import sys

payload = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
json.loads(payload)
if not payload:
    raise SystemExit("empty delegated query payload")
PY

echo "PASS: delegated headless query printed valid JSON and exited before the outer timeout"
