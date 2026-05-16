#!/usr/bin/env bash
# Verify the build log stays free of two specific warnings:
#   1. tsup/esbuild "types" condition unreachable (export map ordering).
#   2. pnpm "No projects matched the filters" (stale @invoker/executors filter).
#
# Modes:
#   export-order    Check every workspace package.json exports object so that
#                   when a "types" condition is present it precedes "import"
#                   and "require". Exits 0 on pass; nonzero if any export map
#                   has "types" after "import" or "require".
#   targeted-builds Build @invoker/core, @invoker/persistence, @invoker/app and
#                   fail if the captured output contains an unreachable types
#                   condition warning.
#   run-sh          Check the active build filters in run.sh and
#                   scripts/verify-executor-routing.sh do not reference the
#                   removed @invoker/executors package (which produces the
#                   "No projects matched the filters" warning).
#
# Usage: bash scripts/verify-build-warning-clean.sh <mode>
set -euo pipefail

MODE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<USAGE
usage: $(basename "$0") <export-order|targeted-builds|run-sh>
USAGE
  exit 2
}

run_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
failures = []
for pkg_path in sorted((root / "packages").glob("*/package.json")):
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    except Exception as exc:
        failures.append(f"{pkg_path}: failed to parse ({exc})")
        continue
    exports = pkg.get("exports")
    if not isinstance(exports, dict):
        continue
    for subpath, value in exports.items():
        if not isinstance(value, dict):
            continue
        keys = list(value.keys())
        if "types" not in keys:
            continue
        types_idx = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < types_idx:
                failures.append(
                    f"{pkg_path}: exports[{subpath!r}] has 'types' after '{cond}' (order: {keys})"
                )
                break

if failures:
    print("FAIL: types condition ordering issues:")
    for line in failures:
        print(f"  - {line}")
    sys.exit(1)

print("PASS: all workspace package exports list 'types' before 'import'/'require'.")
PY
}

run_targeted_builds() {
  local logfile
  logfile="$(mktemp -t verify-build-warning-clean.XXXXXX)"
  trap 'rm -f "$logfile"' RETURN

  local failed=0
  for pkg in "@invoker/core" "@invoker/persistence" "@invoker/app"; do
    echo "==> building $pkg" >&2
    if ! pnpm --filter "$pkg" build >>"$logfile" 2>&1; then
      echo "FAIL: build for $pkg exited non-zero" >&2
      failed=1
    fi
  done

  if grep -E -n 'The condition "types"[^"]*never be used|"types" condition.*unreachable' "$logfile" >&2; then
    echo "FAIL: unreachable 'types' condition warning detected in build output." >&2
    return 1
  fi

  if [ "$failed" -ne 0 ]; then
    return 1
  fi

  echo "PASS: targeted builds completed without unreachable 'types' condition warnings."
}

run_run_sh() {
  local files=(
    "run.sh"
    "scripts/verify-executor-routing.sh"
  )
  local failures=()
  for f in "${files[@]}"; do
    if [ ! -f "$f" ]; then
      continue
    fi
    # Strip comments to focus on active commands; flag any remaining
    # @invoker/executors reference.
    if grep -nE '^[^#]*@invoker/executors' "$f" >/dev/null 2>&1; then
      while IFS= read -r line; do
        failures+=("$f:$line")
      done < <(grep -nE '^[^#]*@invoker/executors' "$f")
    fi
  done
  if [ "${#failures[@]}" -gt 0 ]; then
    echo "FAIL: stale @invoker/executors filter found in active launcher commands:" >&2
    for line in "${failures[@]}"; do
      echo "  - $line" >&2
    done
    return 1
  fi
  echo "PASS: launcher scripts no longer reference @invoker/executors."
}

case "$MODE" in
  export-order) run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh) run_run_sh ;;
  *) usage ;;
esac
