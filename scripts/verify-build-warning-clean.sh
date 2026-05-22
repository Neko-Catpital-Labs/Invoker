#!/usr/bin/env bash
# Verify that build output is free of the noisy warnings produced by stale
# export-condition ordering and stale workspace package filters.
#
# Modes:
#   export-order     Scan every packages/*/package.json export object and fail
#                    if "types" appears after "import" or "require".
#   targeted-builds  Run the canonical targeted builds and fail if tsup/esbuild
#                    emit unreachable "types" condition warnings.
#   run-sh           Fail if active launcher/helper scripts still reference the
#                    removed @invoker/executors package as a build filter or if
#                    pnpm emits "No projects matched the filters".
#
# Each mode exits 0 on pass and nonzero when its warning markers are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "Usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 2
}

mode="${1:-}"
[ -z "$mode" ] && usage

run_export_order() {
  python3 - "$ROOT" <<'PY'
import json, pathlib, sys

root = pathlib.Path(sys.argv[1])
packages_dir = root / "packages"
fail = []

def visit(path, node):
    if not isinstance(node, dict):
        return
    keys = list(node.keys())
    if "types" in keys and ("import" in keys or "require" in keys):
        ti = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < ti:
                fail.append(f"{path}: 'types' condition appears after '{cond}'")
                break
    for value in node.values():
        visit(path, value)

for pkg_json in sorted(packages_dir.glob("*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail.append(f"{pkg_json}: invalid JSON ({exc})")
        continue
    exports = data.get("exports")
    if exports is None:
        continue
    visit(pkg_json.relative_to(root), exports)

if fail:
    print("export-order: FAIL", file=sys.stderr)
    for line in fail:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

print("export-order: PASS — all workspace package export objects list 'types' before 'import'/'require'.")
PY
}

scan_for_warnings() {
  local log="$1"
  local rc=0
  if grep -E "This \"types\" condition will never be used" "$log" >/dev/null 2>&1; then
    echo "FAIL: unreachable 'types' condition warning present in build output" >&2
    grep -nE "This \"types\" condition will never be used" "$log" >&2 || true
    rc=1
  fi
  if grep -E "No projects matched the filters" "$log" >/dev/null 2>&1; then
    echo "FAIL: pnpm 'No projects matched the filters' warning present in build output" >&2
    grep -nE "No projects matched the filters" "$log" >&2 || true
    rc=1
  fi
  return $rc
}

run_targeted_builds() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN
  local builds=(
    "@invoker/core"
    "@invoker/persistence"
    "@invoker/app"
  )
  local pkg
  for pkg in "${builds[@]}"; do
    echo "==> pnpm --filter $pkg build" >&2
    if ! pnpm --filter "$pkg" build >>"$log" 2>&1; then
      echo "FAIL: build failed for $pkg" >&2
      tail -n 80 "$log" >&2 || true
      return 1
    fi
  done
  if ! scan_for_warnings "$log"; then
    return 1
  fi
  echo "targeted-builds: PASS — canonical builds emitted no unreachable 'types' or 'No projects matched' warnings."
}

run_run_sh() {
  local rc=0
  local files=(
    "run.sh"
    "scripts/verify-executor-routing.sh"
  )
  local f
  for f in "${files[@]}"; do
    if [ ! -f "$ROOT/$f" ]; then
      echo "FAIL: expected launcher/helper file not found: $f" >&2
      rc=1
      continue
    fi
    if grep -nE "pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors" "$ROOT/$f" >/dev/null 2>&1; then
      echo "FAIL: $f still uses the removed @invoker/executors build filter" >&2
      grep -nE "pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors" "$ROOT/$f" >&2 || true
      rc=1
    fi
  done
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  echo "run-sh: PASS — no active script uses the removed @invoker/executors filter."
}

case "$mode" in
  export-order)    run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh)          run_run_sh ;;
  *)               usage ;;
esac
