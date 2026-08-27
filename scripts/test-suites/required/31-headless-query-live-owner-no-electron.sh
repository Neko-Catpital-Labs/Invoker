#!/usr/bin/env bash
# Regression: default headless_query must not spawn checkout Electron.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

TMP_ROOT="$(mktemp -d -t invoker-headless-query-no-electron.XXXXXX)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

FAKE_ELECTRON="$TMP_ROOT/electron-must-not-run.sh"
FAKE_CLIENT="$TMP_ROOT/fake-owner-client.sh"
MARKER="$TMP_ROOT/electron-ran"

cat > "$FAKE_ELECTRON" <<SH
#!/usr/bin/env bash
echo ran > "$MARKER"
exit 1
SH
chmod +x "$FAKE_ELECTRON"

cat > "$FAKE_CLIENT" <<'SH'
#!/usr/bin/env bash
printf '[]\n'
SH
chmod +x "$FAKE_CLIENT"

unset INVOKER_HEADLESS_STANDALONE || true
unset INVOKER_HEADLESS_ELECTRON_BIN || true
export INVOKER_HEADLESS_CLIENT_BIN="$FAKE_CLIENT"

# shellcheck source=../../scripts/headless-lib.sh
source "$ROOT/scripts/headless-lib.sh"
ELECTRON="$FAKE_ELECTRON"
MAIN="$TMP_ROOT/missing-main.js"

OUT="$TMP_ROOT/out.json"
headless_query query workflows --output json >"$OUT"

if [[ -f "$MARKER" ]]; then
  echo "FAIL: headless_query spawned checkout Electron while not in STANDALONE mode" >&2
  exit 1
fi
if ! grep -Fxq '[]' "$OUT"; then
  echo "FAIL: expected fake owner client stdout" >&2
  cat "$OUT" >&2
  exit 1
fi
echo "PASS: default headless_query used the owner client, not checkout Electron"
