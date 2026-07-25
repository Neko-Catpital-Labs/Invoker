#!/usr/bin/env bash
# Guardrail: the shared app-build-dist CI artifact must package packages/surfaces/dist.
#
# Regression: build-artifacts only tarred packages/ui/dist and packages/app/dist. The
# built Electron app requires @invoker/surfaces at runtime (it stays external in
# packages/app/tsup.config.ts's noExternal list), so every required-fast/ssh/e2e-proof/
# playwright job that downloaded the artifact crashed with
# "Cannot find module '.../@invoker/surfaces/dist/index.js'" and hung until CI timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

WORKFLOW="$ROOT/.github/workflows/ci.yml"
STEP="$(awk '/name: Build UI and app/{flag=1} flag{print} flag && /tar -czf app-build-dist.tgz/{exit}' "$WORKFLOW")"

if [[ -z "$STEP" ]]; then
  echo "FAIL: could not find the 'Build UI and app' step in $WORKFLOW" >&2
  exit 1
fi

if ! grep -q 'pnpm --filter @invoker/surfaces build' <<<"$STEP"; then
  echo "FAIL: build-artifacts must build @invoker/surfaces before packaging app-build-dist.tgz" >&2
  exit 1
fi

if ! grep -q 'tar -czf app-build-dist.tgz.*packages/surfaces/dist' <<<"$STEP"; then
  echo "FAIL: app-build-dist.tgz must include packages/surfaces/dist (required at runtime by @invoker/app)" >&2
  exit 1
fi

echo "PASS: app-build-dist.tgz packages packages/surfaces/dist"
