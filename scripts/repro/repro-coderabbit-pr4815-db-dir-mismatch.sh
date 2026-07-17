#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SCRIPT="$ROOT_DIR/scripts/repro/repro-downstream-gate-blind-to-db-completed-upstream.sh"
WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/invoker-coderabbit-pr4815-db-dir.XXXXXX")"
OUTPUT_FILE="$WORK_TMP/target-output.txt"

cleanup() {
  rm -rf "$WORK_TMP"
}
trap cleanup EXIT

if [ ! -x "$TARGET_SCRIPT" ]; then
  echo "FAIL: target repro is not executable: $TARGET_SCRIPT" >&2
  exit 1
fi

echo "temporary_root=$WORK_TMP"
echo "target_repro=$TARGET_SCRIPT"

if ! TMPDIR="$WORK_TMP" bash "$TARGET_SCRIPT" >"$OUTPUT_FILE" 2>&1; then
  cat "$OUTPUT_FILE" >&2
  echo "FAIL: target repro failed before DB directory ownership could be checked" >&2
  exit 1
fi

reported_db_dir="$(sed -n 's/^temporary_db_dir=//p' "$OUTPUT_FILE" | tail -n 1)"
if [ -z "$reported_db_dir" ]; then
  cat "$OUTPUT_FILE" >&2
  echo "FAIL: target repro did not print temporary_db_dir" >&2
  exit 1
fi

stray_db_files="$(find "$WORK_TMP" -mindepth 2 -maxdepth 2 -type f -name 'invoker.db' -print | sort)"

if [ -n "$stray_db_files" ]; then
  cat "$OUTPUT_FILE" >&2
  echo "reported_temporary_db_dir=$reported_db_dir" >&2
  echo "stray_db_files:" >&2
  printf '%s\n' "$stray_db_files" >&2
  echo "FAIL: generated test ignored the harness DB_DIR and left a separate SQLite database behind" >&2
  exit 1
fi

echo "reported_temporary_db_dir=$reported_db_dir"
echo "PASS: generated test uses the harness-provided DB_DIR; no separate SQLite database remains"
