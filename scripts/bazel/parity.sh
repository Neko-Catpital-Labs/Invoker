#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "$#" -lt 1 ]; then
  echo "Usage: bash scripts/bazel/parity.sh <pkg-dir> [<pkg-dir> ...]" >&2
  exit 64
fi

FAIL=0
for PKG_DIR in "$@"; do
  PKG_JSON="$ROOT/packages/$PKG_DIR/package.json"
  if [ ! -f "$PKG_JSON" ]; then
    echo "missing $PKG_JSON" >&2
    FAIL=1
    continue
  fi
  PKG_NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).name)" "$PKG_JSON")"
  echo "==> parity $PKG_DIR ($PKG_NAME)"

  set +e
  pnpm --filter "$PKG_NAME" test
  PNPM_EC=$?
  bazelisk test "//packages/$PKG_DIR:test" \
    --test_env=BUILD_WORKSPACE_DIRECTORY="$ROOT" \
    --test_env=PATH="$PATH" \
    --test_output=errors
  BAZEL_EC=$?
  set -e

  if [ "$PNPM_EC" -ne "$BAZEL_EC" ]; then
    echo "FAIL parity $PKG_DIR: pnpm=$PNPM_EC bazel=$BAZEL_EC" >&2
    FAIL=1
  elif [ "$PNPM_EC" -ne 0 ]; then
    echo "FAIL both failed for $PKG_DIR (exit $PNPM_EC)" >&2
    FAIL=1
  else
    echo "OK parity $PKG_DIR"
  fi
done

exit "$FAIL"
