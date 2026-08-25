#!/usr/bin/env bash
# Guardrail: every path that builds the Electron app must compile
# packages/surfaces/dist first. @invoker/surfaces stays external in
# packages/app/tsup.config.ts (not bundled), so a missing dist makes
# packages/app's verify-workspace-imports.cjs throw
# "Unresolvable workspace dependency @invoker/surfaces".
#
# Siblings:
# - CI build-artifacts "Build UI and app" step (app-build-dist.tgz)
# - scripts/package-desktop.sh (tagged + daily GitHub Release cuts)
#
# Regression: build-artifacts only tarred packages/ui/dist and packages/app/dist.
# required-fast/ssh/e2e-proof/playwright jobs then crashed with
# "Cannot find module '.../@invoker/surfaces/dist/index.js'" and hung until
# CI timeout (#5845). package-desktop.sh was not updated, so tagged/daily
# desktop jobs hit the same class later.
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

PACKAGE_DESKTOP="$ROOT/scripts/package-desktop.sh"
if ! grep -q 'pnpm --filter @invoker/surfaces build' "$PACKAGE_DESKTOP"; then
  echo "FAIL: package-desktop.sh must build @invoker/surfaces before @invoker/app (tagged/daily desktop cuts)" >&2
  exit 1
fi

surfaces_line="$(grep -n 'pnpm --filter @invoker/surfaces build' "$PACKAGE_DESKTOP" | head -n1 | cut -d: -f1)"
app_line="$(grep -n 'pnpm --filter @invoker/app build' "$PACKAGE_DESKTOP" | head -n1 | cut -d: -f1)"
if [[ -z "$surfaces_line" || -z "$app_line" || "$surfaces_line" -ge "$app_line" ]]; then
  echo "FAIL: package-desktop.sh must run @invoker/surfaces build before @invoker/app build" >&2
  exit 1
fi

echo "PASS: app-build-dist.tgz and package-desktop.sh both build packages/surfaces/dist"
