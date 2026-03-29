#!/usr/bin/env bash
# End-to-end validation: headless Invoker run + SQLite check (same as plans/verify-executor-familiar-headless.yaml).
# Usage (from repo root): bash scripts/verify-executor-familiar-invoker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f packages/app/dist/main.js ]]; then
  echo "ERROR: packages/app/dist/main.js missing — run: pnpm --filter @invoker/app build" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"
invoker_e2e_init
trap invoker_e2e_cleanup EXIT

unset ELECTRON_RUN_AS_NODE
echo "==> headless delete-all (clear workflows for clean verify)"
./run.sh --headless delete-all

echo "==> submit-plan (headless run) plans/verify-executor-familiar-headless.yaml"
./submit-plan.sh plans/verify-executor-familiar-headless.yaml
