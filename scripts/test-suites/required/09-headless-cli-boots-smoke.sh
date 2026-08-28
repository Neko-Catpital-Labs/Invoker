#!/usr/bin/env bash
# Guardrail: packages/app/dist/main.js must actually boot and answer a
# headless query, not just build without a tsc/tsup error.
#
# Regression (2026-08-13): @invoker/slack-bug-scan was left out of
# packages/app/tsup.config.ts's noExternal list. Its package.json points
# main/exports straight at raw src/index.ts (never compiled to dist), so
# leaving it external meant Node tried to resolve that TypeScript file's own
# relative imports (e.g. "./contract.js") against the filesystem at runtime
# and failed with ERR_MODULE_NOT_FOUND the moment any code path touched the
# slack-bug-scan worker. The crash happened during Electron's app "ready"
# load phase as an uncaught main-process exception, so the process never
# exited -- every `scripts/headless-lib.sh` caller (every cron worker,
# including e2e-autofix's ci-regression-watch sweep) hung until its own
# external timeout killed it, and every check it was mid-way through was
# silently treated as "assume non-terminal work exists, skip filing". A
# production droplet ran for an unknown period filing zero CI-regression
# repair PRs with no visible error anywhere in that path.
#
# This is a functional check, not a config-text grep: it actually runs the
# built CLI end to end, so it also covers any other workspace dependency
# left external by mistake in the future, not just this one package.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

MAIN="$ROOT/packages/app/dist/main.js"
if [[ ! -f "$MAIN" ]]; then
  echo "FAIL: $MAIN does not exist -- build @invoker/app before running this check" >&2
  exit 1
fi

ELECTRON="$ROOT/scripts/electron.cjs"
SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
fi

OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

STATUS=0
# shellcheck disable=SC2086
timeout 30 "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless query workflows --output json >"$OUT" 2>"$ERR" || STATUS=$?

if [[ "$STATUS" -eq 124 ]]; then
  echo "FAIL: headless CLI hung for 30s and was killed. This is the exact symptom of a" >&2
  echo "workspace dependency left external in packages/app/tsup.config.ts's noExternal" >&2
  echo "whose package.json main/exports points at unbuilt raw .ts source -- Node's ESM" >&2
  echo "loader crashes the Electron main process during load, and the crashed process" >&2
  echo "never exits on its own." >&2
  echo "-- stderr --" >&2
  cat "$ERR" >&2
  exit 1
fi

if [[ "$STATUS" -ne 0 ]]; then
  echo "FAIL: headless CLI exited $STATUS" >&2
  echo "-- stderr --" >&2
  cat "$ERR" >&2
  exit 1
fi

if ! python3 -c "import json,sys; json.load(open('$OUT'))" 2>/dev/null; then
  echo "FAIL: headless CLI exited 0 but did not print valid JSON" >&2
  echo "-- stdout --" >&2
  cat "$OUT" >&2
  echo "-- stderr --" >&2
  cat "$ERR" >&2
  exit 1
fi

echo "PASS: packages/app/dist/main.js boots and answers a headless query"
