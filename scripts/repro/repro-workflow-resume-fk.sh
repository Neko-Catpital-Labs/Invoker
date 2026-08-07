#!/usr/bin/env bash
# Repro: the real workflow-resume worker tick must audit
# recovery.worker.submit against a real task id, not a bare workflow id. The
# wrapper bundles the TypeScript sources with the repo's own esbuild so this can
# run as a checked-in production-bug guard without installing tsx or vitest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-workflow-resume-fk.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

DRIVER="${INVOKER_PREBUILT_WORKFLOW_RESUME_FK_DRIVER:-}"
if [ -z "$DRIVER" ]; then
  ESBUILD="$ROOT/node_modules/.bin/esbuild"
  if [ ! -x "$ESBUILD" ]; then
    ESBUILD="$(find "$ROOT/node_modules/.pnpm" -type f -path '*/node_modules/esbuild/bin/esbuild' -print 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
  [ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found; set INVOKER_PREBUILT_WORKFLOW_RESUME_FK_DRIVER"; exit 1; }
  DRIVER="$TMP/driver.mjs"
  "$ESBUILD" scripts/repro/repro-workflow-resume-fk-driver.mjs \
    --bundle --platform=node --format=esm --outfile="$DRIVER" \
    --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
    --log-level=warning
fi

node "$DRIVER"
