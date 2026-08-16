#!/usr/bin/env bash
# run.sh's delete-all path runs unconditionally (no production-DB guard, see
# #9290/#9291/#9305/#9306); this asserts it still snapshots the DB before
# deleting, since that snapshot is the only remaining safety net.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

DB_DIR="$(mktemp -d)"
trap 'rm -rf "$DB_DIR"' EXIT

set +e
OUT="$(INVOKER_DB_DIR="$DB_DIR" INVOKER_HEADLESS_STANDALONE=1 ./run.sh --headless delete-all 2>&1)"
EC=$?
set -e

if [[ "$EC" -ne 0 ]]; then
  echo "FAIL: expected run.sh --headless delete-all to exit 0"
  echo "$OUT"
  exit 1
fi

if ! grep -q "All workflows deleted." <<<"$OUT"; then
  echo "FAIL: expected delete-all completion message"
  echo "$OUT"
  exit 1
fi

echo "PASS: delete-all runs unconditionally and completes"
