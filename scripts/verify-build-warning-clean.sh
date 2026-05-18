#!/usr/bin/env bash
# verify-build-warning-clean.sh — confirm the ./run.sh build path is quiet.
#
# Modes:
#   export-order     Scan packages/*/package.json export blocks. Fails if any
#                    export object has the "types" condition after "import" or
#                    "require" (the ordering that triggers tsup/esbuild's
#                    `"types" ... will never be used` warning).
#   targeted-builds  Run the targeted package builds called out in the plan
#                    (@invoker/core, @invoker/persistence, @invoker/app) and
#                    fail if their combined output contains the unreachable
#                    "types" condition warning marker.
#   run-sh           Scan active launcher/helper scripts for stale workspace
#                    filter references (the trigger for pnpm's
#                    "No projects matched the filters" warning).
#
# Exit code 0 = pass (no warning markers). Nonzero = fail.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

usage() {
  cat >&2 <<USAGE
Usage: $0 <mode>
  mode: export-order | targeted-builds | run-sh
USAGE
  exit 64
}

run_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
problems = []
for pkg_json in sorted(root.glob('packages/*/package.json')):
    try:
        data = json.loads(pkg_json.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        print(f'ERROR: invalid JSON in {pkg_json}: {exc}', file=sys.stderr)
        sys.exit(2)
    exports = data.get('exports')
    if not isinstance(exports, dict):
        continue
    for subpath, conditions in exports.items():
        if not isinstance(conditions, dict):
            continue
        keys = list(conditions.keys())
        if 'types' not in keys:
            continue
        types_idx = keys.index('types')
        for cond in ('import', 'require'):
            if cond in keys and keys.index(cond) < types_idx:
                problems.append(
                    f'{pkg_json.relative_to(root)}: exports["{subpath}"] '
                    f'has "types" after "{cond}"'
                )
                break
if problems:
    print('FAIL: stale export condition ordering detected', file=sys.stderr)
    for line in problems:
        print(f'  {line}', file=sys.stderr)
    sys.exit(1)
print('PASS: every workspace export places "types" before "import"/"require"')
PY
}

run_targeted_builds() {
  local log
  log="$(mktemp -t verify-build-warning-clean.XXXXXX)"
  trap 'rm -f "$log"' RETURN

  for pkg in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> building $pkg" >&2
    if ! pnpm --filter "$pkg" build >>"$log" 2>&1; then
      echo "FAIL: build failed for $pkg" >&2
      cat "$log" >&2
      return 1
    fi
  done

  # tsup/esbuild emits:
  #   "WARNING: The condition "types" here will never be used as it comes
  #    after both "import" and "require""
  # We treat any "types" + "will never be used" co-occurrence as the marker.
  if grep -Eq '"types"[^"]*will never be used' "$log"; then
    echo 'FAIL: targeted builds emitted unreachable "types" condition warnings' >&2
    grep -nE '"types"[^"]*will never be used' "$log" >&2 || true
    return 1
  fi
  echo 'PASS: targeted builds emitted no unreachable "types" condition warnings'
}

run_run_sh() {
  local files=(run.sh scripts/verify-executor-routing.sh)
  local hits=""
  for file in "${files[@]}"; do
    if [ ! -f "$file" ]; then
      continue
    fi
    local matches
    matches="$(grep -nE -- '--filter[ =]+@invoker/executors\b|--filter[ =]+["'\'']@invoker/executors' "$file" || true)"
    if [ -n "$matches" ]; then
      hits+="$file:"$'\n'"$matches"$'\n'
    fi
  done
  if [ -n "$hits" ]; then
    echo 'FAIL: launcher/helper scripts still filter on @invoker/executors' >&2
    printf '%s' "$hits" >&2
    return 1
  fi
  echo 'PASS: launcher/helper scripts do not reference @invoker/executors as a build filter'
}

case "$MODE" in
  export-order) run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh) run_run_sh ;;
  '') usage ;;
  *) usage ;;
esac
