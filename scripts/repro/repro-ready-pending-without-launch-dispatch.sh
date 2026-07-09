#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_FILE="$(mktemp -t invoker-ready-pending-without-dispatch.XXXXXX.log)"
trap 'rm -f "$OUT_FILE"' EXIT

bash "$ROOT_DIR/scripts/retry-pending-autofix-failed.sh" --self-test > "$OUT_FILE" 2>&1

grep -Fq "self-test: ready pending task without launch dispatch resets retry state" "$OUT_FILE"
grep -Fq "self-test: all passed" "$OUT_FILE"

echo "PASS: ready pending tasks without launch dispatch reset retry state and submit targeted retry-task recovery"
