#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT

status=0
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/e2e-autofix-worker.test.ts -t "red default branch alert" \
  --reporter=json --outputFile="$REPORT" || status=$?

if [ ! -s "$REPORT" ]; then
  echo "prove-red-default-branch-alert: vitest produced no report (exit $status)" >&2
  exit 2
fi

if [ "$status" -eq 0 ] \
  && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(r.numPassedTests > 0 && r.numFailedTests === 0 ? 0 : 1)' "$REPORT"; then
  echo "prove-red-default-branch-alert: ok"
  exit 0
fi

echo "prove-red-default-branch-alert: red-default-branch alert defect is present" >&2
exit 1
