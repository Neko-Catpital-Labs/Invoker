#!/usr/bin/env bash
# Verify that the targeted build pipeline produces a clean log: no esbuild
# "unreachable types condition" warnings from workspace export maps and no
# launcher-script references to the removed @invoker/executors package.
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh export-order
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#   bash scripts/verify-build-warning-clean.sh run-sh
#
# Each mode exits 0 when clean, nonzero when the relevant warning markers
# are present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"

if [[ -z "$MODE" ]]; then
  echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 2
fi

verify_export_order() {
  node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const pkgDir = path.join(root, "packages");
const entries = fs.readdirSync(pkgDir, { withFileTypes: true });
const offenders = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(pkgDir, entry.name, "package.json");
  if (!fs.existsSync(pkgPath)) continue;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    offenders.push(`${pkgPath}: invalid JSON (${err.message})`);
    continue;
  }
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== "object") continue;
  for (const [subpath, conditions] of Object.entries(exportsField)) {
    if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) continue;
    const keys = Object.keys(conditions);
    const typesIdx = keys.indexOf("types");
    if (typesIdx === -1) continue;
    const importIdx = keys.indexOf("import");
    const requireIdx = keys.indexOf("require");
    if ((importIdx !== -1 && typesIdx > importIdx) ||
        (requireIdx !== -1 && typesIdx > requireIdx)) {
      offenders.push(`${pkgPath} exports["${subpath}"]: types must precede import/require (got order [${keys.join(", ")}])`);
    }
  }
}
if (offenders.length > 0) {
  console.error("FAIL: workspace export maps with unreachable types condition:");
  for (const line of offenders) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("PASS: all workspace export maps place types before import/require");
' "$ROOT"
}

verify_targeted_builds() {
  cd "$ROOT"
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local failures=0
  for filter in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> pnpm --filter $filter build"
    if ! pnpm --filter "$filter" build >"$log" 2>&1; then
      echo "FAIL: build for $filter exited nonzero" >&2
      cat "$log" >&2
      failures=$((failures + 1))
      continue
    fi
    if grep -E -i \
        -e '"types" condition' \
        -e 'unreachable.*types' \
        -e 'types.*never.*used' \
        "$log" >/dev/null; then
      echo "FAIL: $filter build emitted unreachable 'types' condition warning:" >&2
      grep -E -i -n \
          -e '"types" condition' \
          -e 'unreachable.*types' \
          -e 'types.*never.*used' \
          "$log" >&2 || true
      failures=$((failures + 1))
    fi
  done

  if (( failures > 0 )); then
    return 1
  fi
  echo "PASS: targeted builds produced no unreachable types warnings"
}

verify_run_sh() {
  local run_sh="$ROOT/run.sh"
  local routing="$ROOT/scripts/verify-executor-routing.sh"
  local failures=0

  for file in "$run_sh" "$routing"; do
    if [[ ! -f "$file" ]]; then
      echo "FAIL: expected file missing: $file" >&2
      failures=$((failures + 1))
      continue
    fi
    if grep -n -- '--filter @invoker/executors' "$file" >/dev/null; then
      echo "FAIL: $file still references @invoker/executors as an active build filter:" >&2
      grep -n -- '--filter @invoker/executors' "$file" >&2 || true
      failures=$((failures + 1))
    fi
    if grep -n -- '"No projects matched the filters"' "$file" >/dev/null; then
      echo "FAIL: $file embeds the 'No projects matched the filters' marker" >&2
      failures=$((failures + 1))
    fi
  done

  if (( failures > 0 )); then
    return 1
  fi
  echo "PASS: launcher scripts do not reference the stale @invoker/executors filter"
}

case "$MODE" in
  export-order)
    verify_export_order
    ;;
  targeted-builds)
    verify_targeted_builds
    ;;
  run-sh)
    verify_run_sh
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
    exit 2
    ;;
esac
