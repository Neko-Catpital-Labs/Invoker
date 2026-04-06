#!/usr/bin/env bash
# Guardrail: run.sh must refuse delete-all against production DB root by default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

set +e
OUT="$(env -u INVOKER_DB_DIR INVOKER_HEADLESS_STANDALONE=1 ./run.sh --headless delete-all 2>&1)"
EC=$?
set -e

if [[ "$EC" -eq 0 ]]; then
  echo "FAIL: expected run.sh --headless delete-all to be blocked for production DB"
  echo "$OUT"
  exit 1
fi

if ! grep -q "Refusing to run 'delete-all' against production DB root" <<<"$OUT"; then
  echo "FAIL: expected production DB guard message"
  echo "$OUT"
  exit 1
fi

echo "PASS: production delete-all guard is enforced"
