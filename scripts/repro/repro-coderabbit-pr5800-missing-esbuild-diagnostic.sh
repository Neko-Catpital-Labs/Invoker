#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr5800-missing-esbuild.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- output -----" >&2
    printf '%s\n' "$2" >&2
  fi
  exit 1
}

mkdir -p "$TMP/repo/scripts/repro"
cp "$ROOT/scripts/repro/repro-pr-maintenance-worker-routing.sh" "$TMP/repo/scripts/repro/"
chmod +x "$TMP/repo/scripts/repro/repro-pr-maintenance-worker-routing.sh"

set +e
output="$(bash "$TMP/repo/scripts/repro/repro-pr-maintenance-worker-routing.sh" 2>&1)"
status=$?
set -e

[ "$status" -ne 0 ] || fail "expected missing-esbuild case to fail"
printf '%s' "$output" | grep -Fq "esbuild not found; set INVOKER_PREBUILT_ROUTING_DRIVER" \
  || fail "missing esbuild lookup exited before the intended diagnostic" "$output"

echo "[repro] PASS: missing esbuild reaches the intended diagnostic"
