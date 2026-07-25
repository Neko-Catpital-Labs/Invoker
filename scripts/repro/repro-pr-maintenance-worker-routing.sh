#!/usr/bin/env bash
# Battle-test: each of the four PR-maintenance WORKERS (the real
# createXWorker runtimes the owner boots) detects its own issue class and
# routes it to the right cron entrypoint against a fake GitHub:
#   pr-conflict-rebase   <- conflicted PR        (pr-dirty.json)
#   pr-ci-failure-scan   <- CI-failed PR         (pr-ci-failed.json)
#   pr-admin-bypass-land <- dequeued landable PR (stack-landable.json)
#   coderabbit-address   <- review sweep         (routing + clean sweep)
#
# The driver imports the worker factories straight from the TypeScript
# sources; esbuild bundles them so no vitest/node_modules are needed at the
# point of execution. Set INVOKER_PREBUILT_ROUTING_DRIVER to a bundle built
# elsewhere (e.g. shipped to a box without node_modules).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-worker-routing.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

DRIVER="${INVOKER_PREBUILT_ROUTING_DRIVER:-}"
if [ -z "$DRIVER" ]; then
  ESBUILD="$ROOT/node_modules/.bin/esbuild"
  if [ ! -x "$ESBUILD" ]; then
    ESBUILD="$(find "$ROOT/node_modules/.pnpm" -type f -path '*/node_modules/esbuild/bin/esbuild' -print 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
  [ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found; set INVOKER_PREBUILT_ROUTING_DRIVER"; exit 1; }
  DRIVER="$TMP/driver.mjs"
  "$ESBUILD" scripts/repro/worker-routing-driver.mjs \
    --bundle --platform=node --format=esm --outfile="$DRIVER" \
    --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
    --log-level=warning
fi

# The fake gh expands its "*" checks default to the repo's real required-check
# names so the landing brain sees every .mergify.yml-required check green.
FAKE_GH_REQUIRED_CHECKS="$(python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, "scripts")
from mergify_admin_requeue_model import load_mergify_rules
_trunk, _labels, required = load_mergify_rules(Path(".mergify.yml"))
print("\n".join(sorted(required)))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

ROUTING_REPO_ROOT="$ROOT" ROUTING_TMP="$TMP/legs" node "$DRIVER"
