#!/usr/bin/env bash
# Verify that workspace metadata and launcher scripts do not produce the
# build-time warnings we recently cleaned up:
#
#   1. tsup/esbuild unreachable "types" condition warnings (caused when an
#      export object lists "types" after "import" or "require").
#   2. pnpm "No projects matched the filters" warnings (caused when launcher
#      scripts pass --filter for packages that no longer exist).
#
# Modes:
#   export-order    — Static check: every packages/*/package.json export object
#                     must list "types" before "import" and "require". Exit 0
#                     when clean, nonzero when any package violates the order.
#   targeted-builds — Run the targeted build commands (@invoker/core,
#                     @invoker/persistence, @invoker/app) and fail if their
#                     stderr contains "types" condition warnings.
#   run-sh          — Static check: active build filters in run.sh and
#                     scripts/verify-executor-routing.sh must not reference the
#                     stale @invoker/executors package.
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh export-order
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#   bash scripts/verify-build-warning-clean.sh run-sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-}"

if [[ -z "$MODE" ]]; then
  echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 2
fi

check_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
packages_dir = root / "packages"
violations = []

for pkg_json in sorted(packages_dir.glob("*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL: {pkg_json}: invalid JSON ({exc})", file=sys.stderr)
        violations.append(str(pkg_json))
        continue
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    for subpath, condition_map in exports.items():
        if not isinstance(condition_map, dict):
            continue
        keys = list(condition_map.keys())
        if "types" not in keys:
            continue
        types_idx = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < types_idx:
                violations.append(
                    f"{pkg_json}: exports[{subpath!r}] lists "
                    f"'types' after '{cond}' (keys: {keys})"
                )
                break

if violations:
    print("Unreachable 'types' condition order found:", file=sys.stderr)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    sys.exit(1)

print("export-order: OK — all workspace export objects list 'types' first")
PY
}

check_targeted_builds() {
  cd "$ROOT"
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local filters=(
    "@invoker/core"
    "@invoker/persistence"
    "@invoker/app"
  )
  local rc=0
  for filter in "${filters[@]}"; do
    echo "==> Building $filter" >&2
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: pnpm --filter $filter build returned nonzero" >&2
      rc=1
    fi
  done

  if grep -E '("types" condition .* will never be used|unreachable .*types.* condition|types.* condition .* unreachable)' "$log" >/dev/null 2>&1; then
    echo "FAIL: targeted build output contains unreachable 'types' condition warnings:" >&2
    grep -nE '("types" condition .* will never be used|unreachable .*types.* condition|types.* condition .* unreachable)' "$log" >&2 || true
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "targeted-builds: OK — no unreachable 'types' condition warnings"
  fi
  return $rc
}

check_run_sh() {
  cd "$ROOT"
  local rc=0
  local files=(
    "run.sh"
    "scripts/verify-executor-routing.sh"
  )
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL: $f not found" >&2
      rc=1
      continue
    fi
    # Look for active filter invocations of the stale package name. Skip
    # comment lines so historical references in comments are not flagged.
    if grep -nE '^[[:space:]]*[^#]*--filter[[:space:]]+@invoker/executors([[:space:]]|$)' "$f" >/dev/null 2>&1; then
      echo "FAIL: $f still references @invoker/executors as an active --filter target:" >&2
      grep -nE '^[[:space:]]*[^#]*--filter[[:space:]]+@invoker/executors([[:space:]]|$)' "$f" >&2 || true
      rc=1
    fi
  done

  if [[ "$rc" -eq 0 ]]; then
    echo "run-sh: OK — no stale @invoker/executors filters in active launcher scripts"
  fi
  return $rc
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
    echo "unknown mode: $MODE" >&2
    echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
    exit 2
    ;;
esac
