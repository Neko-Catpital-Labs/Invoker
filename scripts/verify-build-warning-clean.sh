#!/usr/bin/env bash
# Verify the build log no longer emits the noisy markers tracked by
# wf-1778826126740-7:
#   - tsup/esbuild "unreachable types condition" warnings caused by
#     packages/*/package.json export objects placing "types" after
#     "import"/"require"
#   - "No projects matched the filters" from the launcher referencing the
#     removed @invoker/executors package
#
# Usage: bash scripts/verify-build-warning-clean.sh <mode>
#   mode = export-order    Static check on every workspace package.json
#                          exports object — fails if "types" comes after
#                          "import" or "require".
#   mode = targeted-builds Builds @invoker/core, @invoker/persistence and
#                          @invoker/app and fails if the unreachable types
#                          condition warning appears.
#   mode = run-sh          Greps the active launcher/helper scripts for the
#                          stale @invoker/executors filter; fails if found.
#
# Each mode exits 0 on pass and nonzero when its warning marker is present.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

usage() {
  echo "Usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 64
}

if [[ -z "$MODE" ]]; then
  usage
fi

check_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
pkg_dir = root / "packages"
failures = []

def walk_exports(node, path):
    if not isinstance(node, dict):
        return
    keys = list(node.keys())
    is_conditions = any(k in keys for k in ("types", "import", "require", "default", "node", "browser"))
    if is_conditions and "types" in keys:
        types_idx = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < types_idx:
                failures.append((path, cond, keys))
                break
    for k, v in node.items():
        walk_exports(v, path + [k])

for pkg_json in sorted(pkg_dir.glob("*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"  ! could not parse {pkg_json.relative_to(root)}: {exc}", file=sys.stderr)
        sys.exit(2)
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    walk_exports(exports, [str(pkg_json.relative_to(root))])

if failures:
    print("FAIL: unreachable 'types' condition (types appears after import/require)", file=sys.stderr)
    for path, cond, keys in failures:
        loc = " > ".join(path)
        print(f"  - {loc}: condition order {keys} places 'types' after '{cond}'", file=sys.stderr)
    sys.exit(1)

print("PASS: all workspace export objects place 'types' before 'import'/'require'")
PY
}

check_run_sh() {
  local files=("run.sh" "scripts/verify-executor-routing.sh")
  local failed=0
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      continue
    fi
    if grep -nE '^[[:space:]]*pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors[[:space:]]+build' "$f" >/tmp/verify-build-warning-clean.$$; then
      echo "FAIL: $f still references the removed @invoker/executors package filter:" >&2
      sed 's/^/  /' /tmp/verify-build-warning-clean.$$ >&2
      failed=1
    fi
    rm -f /tmp/verify-build-warning-clean.$$
  done
  if [[ "$failed" -ne 0 ]]; then
    return 1
  fi
  echo "PASS: active launcher/helper scripts no longer filter on @invoker/executors"
}

check_targeted_builds() {
  local log
  log="$(mktemp)"
  local rc=0
  trap 'rm -f "$log"' RETURN

  for filter in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> pnpm --filter $filter build"
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: pnpm --filter $filter build exited nonzero" >&2
      cat "$log" >&2
      return 1
    fi
  done

  # esbuild prints: The condition "types" here will never be used as it comes
  # after both the "import" and "require" conditions
  if grep -nE 'condition "types" .* will never be used' "$log"; then
    echo "FAIL: targeted builds emitted unreachable 'types' condition warnings (see lines above)" >&2
    rc=1
  fi
  # pnpm prints this when a filter matches no workspace package:
  if grep -nE 'No projects matched the filters' "$log"; then
    echo "FAIL: targeted builds emitted 'No projects matched the filters' (stale package filter)" >&2
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "PASS: targeted builds emitted no unreachable 'types' or missing-filter warnings"
  fi
  return "$rc"
}

case "$MODE" in
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
    ;;
esac
