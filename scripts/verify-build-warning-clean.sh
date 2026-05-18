#!/usr/bin/env bash
# Verify that the build pipeline does not emit stale warning markers.
#
# Modes:
#   export-order     Workspace package exports must place "types" before
#                    "import" and "require" so tsup/esbuild does not warn
#                    about unreachable conditions.
#   targeted-builds  pnpm --filter builds for @invoker/core, @invoker/persistence,
#                    and @invoker/app must run without emitting the unreachable
#                    "types" condition warning.
#   run-sh           Active launcher/helper scripts (run.sh,
#                    scripts/verify-executor-routing.sh) must not reference the
#                    stale @invoker/executors package filter.
#
# Each mode exits 0 on pass and nonzero when the relevant warning markers are
# present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<EOF
Usage: bash scripts/verify-build-warning-clean.sh <mode>
Modes:
  export-order
  targeted-builds
  run-sh
EOF
}

mode="${1:-}"
if [[ -z "$mode" ]]; then
  usage
  exit 2
fi

check_export_order() {
  python3 - <<'PY'
import json
import sys
from pathlib import Path

PACKAGES = Path('packages')
bad = []
for pkg in sorted(PACKAGES.iterdir()):
    pkg_json = pkg / 'package.json'
    if not pkg_json.is_file():
        continue
    try:
        data = json.loads(pkg_json.read_text(encoding='utf-8'))
    except Exception as exc:
        print(f'PARSE-FAIL {pkg_json}: {exc}', file=sys.stderr)
        bad.append(str(pkg_json))
        continue
    exports = data.get('exports')
    if not isinstance(exports, dict) or not exports:
        continue
    condition_keys = {'types', 'import', 'require', 'default', 'node', 'browser', 'module'}

    def visit(node, path):
        if not isinstance(node, dict):
            return
        keys = list(node.keys())
        if any(k in condition_keys for k in keys) and 'types' in keys:
            types_idx = keys.index('types')
            for guard in ('import', 'require'):
                if guard in keys and keys.index(guard) < types_idx:
                    bad.append(f'{pkg_json}:{path}: "types" appears after "{guard}"')
                    return
        for k, v in node.items():
            visit(v, f'{path}.{k}')

    visit(exports, 'exports')

if bad:
    for line in bad:
        print(f'FAIL {line}', file=sys.stderr)
    sys.exit(1)
print('PASS export-order: all workspace exports place "types" before "import"/"require".')
PY
}

check_targeted_builds() {
  local pkgs=(@invoker/core @invoker/persistence @invoker/app)
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN
  local fail=0
  for pkg in "${pkgs[@]}"; do
    echo "==> pnpm --filter $pkg build"
    if ! pnpm --filter "$pkg" build >"$log" 2>&1; then
      echo "FAIL build $pkg" >&2
      cat "$log" >&2
      fail=1
      continue
    fi
    if grep -E 'condition.*"types".*will never be used|"types" condition.*never' "$log" >/dev/null 2>&1; then
      echo "FAIL $pkg: unreachable types condition warning detected" >&2
      grep -nE 'condition.*"types".*will never be used|"types" condition.*never' "$log" >&2 || true
      fail=1
    fi
  done
  if [[ "$fail" -ne 0 ]]; then
    return 1
  fi
  echo 'PASS targeted-builds: no unreachable "types" condition warnings.'
}

check_run_sh() {
  local files=("run.sh" "scripts/verify-executor-routing.sh")
  local fail=0
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL missing $f" >&2
      fail=1
      continue
    fi
    if grep -nE '--filter[[:space:]]+@invoker/executors\b' "$f" >/dev/null 2>&1; then
      echo "FAIL $f references stale @invoker/executors filter:" >&2
      grep -nE '--filter[[:space:]]+@invoker/executors\b' "$f" >&2 || true
      fail=1
    fi
  done
  if [[ "$fail" -ne 0 ]]; then
    return 1
  fi
  echo 'PASS run-sh: no stale @invoker/executors filters in active scripts.'
}

case "$mode" in
  export-order)
    check_export_order
    ;;
  targeted-builds)
    check_targeted_builds
    ;;
  run-sh)
    check_run_sh
    ;;
  *)
    usage
    exit 2
    ;;
esac
