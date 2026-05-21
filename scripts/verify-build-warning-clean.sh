#!/usr/bin/env bash
# Verify that the repo's build configuration no longer emits the noisy
# warnings observed in `./run.sh` logs:
#
#   1. tsup/esbuild "unreachable `types` condition" warnings, caused by
#      package export maps that list `types` after `import` or `require`.
#   2. pnpm "No projects matched the filters" warnings, caused by launcher
#      scripts that still filter on the removed `@invoker/executors` package.
#
# Modes:
#   export-order      - Static check: every packages/*/package.json export
#                       object must place `types` before `import`/`require`.
#   targeted-builds   - Build @invoker/core, @invoker/persistence and
#                       @invoker/app and fail if the unreachable `types`
#                       warning marker appears in output.
#   run-sh            - Static check: run.sh and scripts/verify-executor-routing.sh
#                       must not pass `--filter @invoker/executors` (a stale
#                       package filter that triggers the launcher warning).
#
# Each mode exits 0 on pass and a nonzero status when the relevant warning
# markers are detected.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

usage() {
  cat >&2 <<EOF
Usage: bash scripts/verify-build-warning-clean.sh <mode>

Modes:
  export-order      Verify every packages/*/package.json export map orders
                    \`types\` before \`import\`/\`require\`.
  targeted-builds   Build @invoker/core, @invoker/persistence and @invoker/app
                    and fail if the unreachable \`types\` warning is emitted.
  run-sh            Verify run.sh and scripts/verify-executor-routing.sh do
                    not still pass the stale @invoker/executors filter.
EOF
}

if [[ -z "$MODE" ]]; then
  usage
  exit 2
fi

verify_export_order() {
  node --experimental-vm-modules - "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const packagesDir = path.join(root, 'packages');
const failures = [];

function walkExports(pkgPath, node, trail) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const keys = Object.keys(node);
  const conditionKeys = ['types', 'import', 'require', 'default', 'node', 'browser'];
  const hasConditionKey = keys.some((k) => conditionKeys.includes(k));
  if (hasConditionKey) {
    const typesIdx = keys.indexOf('types');
    if (typesIdx !== -1) {
      const importIdx = keys.indexOf('import');
      const requireIdx = keys.indexOf('require');
      const earlier = [];
      if (importIdx !== -1 && importIdx < typesIdx) earlier.push('import');
      if (requireIdx !== -1 && requireIdx < typesIdx) earlier.push('require');
      if (earlier.length > 0) {
        failures.push({
          pkg: path.relative(root, pkgPath),
          trail: trail.join(' -> ') || '<root>',
          earlier,
        });
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    walkExports(pkgPath, value, [...trail, key]);
  }
}

const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const pkgFile = path.join(packagesDir, entry.name, 'package.json');
  if (!fs.existsSync(pkgFile)) continue;
  const raw = fs.readFileSync(pkgFile, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: ${pkgFile} - invalid JSON: ${err.message}`);
    process.exit(1);
  }
  if (json.exports && typeof json.exports === 'object') {
    walkExports(pkgFile, json.exports, []);
  }
}

if (failures.length > 0) {
  console.error('FAIL: package export maps with `types` after `import`/`require`:');
  for (const f of failures) {
    console.error(`  - ${f.pkg} (subpath ${f.trail}): listed after ${f.earlier.join(', ')}`);
  }
  process.exit(1);
}

console.log('PASS: all packages/*/package.json export maps place `types` before `import`/`require`.');
NODE
}

verify_targeted_builds() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local marker='"types" condition'
  local status=0

  for pkg in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> Building $pkg" >&2
    if ! pnpm --filter "$pkg" build >>"$log" 2>&1; then
      echo "FAIL: build for $pkg exited nonzero." >&2
      cat "$log" >&2
      return 1
    fi
  done

  if grep -E -i "(unreachable.*types|$marker.*(unused|unreachable)|never be used because)" "$log" >/dev/null; then
    echo "FAIL: unreachable \`types\` condition warning detected in build output:" >&2
    grep -E -i -n "(unreachable.*types|$marker.*(unused|unreachable)|never be used because)" "$log" >&2 || true
    return 1
  fi

  echo "PASS: targeted builds emitted no unreachable \`types\` condition warning."
  return $status
}

verify_run_sh() {
  local failed=0
  local stale='@invoker/executors'

  for script in run.sh scripts/verify-executor-routing.sh; do
    if [[ ! -f "$ROOT/$script" ]]; then
      echo "FAIL: expected helper script not found: $script" >&2
      failed=1
      continue
    fi
    if grep -n -E -- "--filter[[:space:]]+$stale\b" "$ROOT/$script" >/dev/null; then
      echo "FAIL: $script still passes --filter $stale (would trigger 'No projects matched the filters'):" >&2
      grep -n -E -- "--filter[[:space:]]+$stale\b" "$ROOT/$script" >&2 || true
      failed=1
    fi
  done

  if [[ $failed -ne 0 ]]; then
    return 1
  fi

  echo "PASS: launcher and helper scripts no longer filter on $stale."
  return 0
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
  -h|--help|help)
    usage
    ;;
  *)
    echo "ERROR: unknown mode: $MODE" >&2
    usage
    exit 2
    ;;
esac
