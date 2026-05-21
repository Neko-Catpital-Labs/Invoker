#!/usr/bin/env bash
# Verify that the workspace build does not emit either of the noisy
# warnings cleaned up in the export-conditions normalization pass:
#
#   1. tsup/esbuild "unreachable types condition" warnings caused by
#      package.json export objects that list "types" after "import" /
#      "require".
#   2. The "No projects matched the filters" launcher warning caused by
#      run.sh / scripts/verify-executor-routing.sh filtering on the
#      stale @invoker/executors package name.
#
# Modes (each exits 0 on pass, nonzero on detected warning markers):
#
#   export-order     Static check: every workspace package.json `exports`
#                    object must list "types" before "import"/"require".
#   targeted-builds  Run the three targeted builds from the acceptance
#                    criteria (@invoker/core, @invoker/persistence,
#                    @invoker/app) and grep their output for unreachable
#                    "types" condition warnings.
#   run-sh           Scan run.sh and scripts/verify-executor-routing.sh
#                    for active --filter references to the removed
#                    @invoker/executors package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'USAGE'
usage: scripts/verify-build-warning-clean.sh <mode>

Modes:
  export-order     Check packages/*/package.json export condition ordering.
  targeted-builds  Build @invoker/core, @invoker/persistence, @invoker/app
                   and fail if tsup/esbuild emits "unreachable types"
                   condition warnings.
  run-sh           Check run.sh and scripts/verify-executor-routing.sh for
                   stale @invoker/executors --filter references.
USAGE
}

mode="${1:-}"
if [[ -z "$mode" ]]; then
  usage
  exit 2
fi

case "$mode" in
  export-order)
    node - "$ROOT" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const packagesDir = path.join(root, 'packages');
const entries = fs.readdirSync(packagesDir, { withFileTypes: true });

let bad = 0;
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(packagesDir, entry.name, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`FAIL: ${pkgPath}: invalid JSON (${err.message})`);
    bad += 1;
    continue;
  }

  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object') continue;

  for (const [subpath, value] of Object.entries(exportsField)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const keys = Object.keys(value);
    const typesIdx = keys.indexOf('types');
    if (typesIdx === -1) continue;

    const importIdx = keys.indexOf('import');
    const requireIdx = keys.indexOf('require');
    const violatesImport = importIdx !== -1 && typesIdx > importIdx;
    const violatesRequire = requireIdx !== -1 && typesIdx > requireIdx;
    if (violatesImport || violatesRequire) {
      console.error(
        `FAIL: ${pkg.name || entry.name} exports["${subpath}"] lists "types" after ${
          violatesImport && violatesRequire
            ? '"import"/"require"'
            : violatesImport
              ? '"import"'
              : '"require"'
        } (keys: ${keys.join(', ')})`
      );
      bad += 1;
    }
  }
}

if (bad > 0) {
  console.error(`export-order: ${bad} package(s) have unreachable "types" condition ordering.`);
  process.exit(1);
}
console.log('export-order: all workspace exports list "types" before "import"/"require".');
NODE
    ;;

  targeted-builds)
    log_dir="$(mktemp -d)"
    trap 'rm -rf "$log_dir"' EXIT
    status=0
    for pkg in @invoker/core @invoker/persistence @invoker/app; do
      log_file="$log_dir/$(echo "$pkg" | tr '/@' '_').log"
      echo "==> building $pkg"
      if ! pnpm --filter "$pkg" build >"$log_file" 2>&1; then
        echo "FAIL: $pkg build returned nonzero exit"
        cat "$log_file" >&2
        status=1
        continue
      fi

      # esbuild prints lines like:
      #   ▲ [WARNING] The condition "types" here will never be used as it comes
      #     earlier than both "import" and "require" [unsupported-require-call]
      # or similar phrasing referencing the unreachable "types" condition.
      if grep -E -i '("types".*(never be used|unreachable|comes after|here will))|(unreachable.*"types")' \
           "$log_file" >/dev/null; then
        echo "FAIL: $pkg build emitted unreachable types condition warnings:"
        grep -E -n -i '("types".*(never be used|unreachable|comes after|here will))|(unreachable.*"types")' \
          "$log_file" >&2 || true
        status=1
      fi
    done

    if [[ $status -ne 0 ]]; then
      exit 1
    fi
    echo "targeted-builds: no unreachable types condition warnings detected."
    ;;

  run-sh)
    status=0
    for file in run.sh scripts/verify-executor-routing.sh; do
      if [[ ! -f "$file" ]]; then
        echo "FAIL: missing $file"
        status=1
        continue
      fi
      if grep -E -n -- '--filter[[:space:]]+@invoker/executors\b' "$file" >/dev/null; then
        echo "FAIL: $file still references the stale @invoker/executors filter:"
        grep -E -n -- '--filter[[:space:]]+@invoker/executors\b' "$file" >&2
        status=1
      fi
    done

    if [[ $status -ne 0 ]]; then
      exit 1
    fi
    echo "run-sh: no stale @invoker/executors --filter references found."
    ;;

  -h|--help|help)
    usage
    exit 0
    ;;

  *)
    echo "Unknown mode: $mode" >&2
    usage
    exit 2
    ;;
esac
