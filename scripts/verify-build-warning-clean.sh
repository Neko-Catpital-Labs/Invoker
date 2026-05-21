#!/usr/bin/env bash
# Verify that build warnings from stale workspace metadata are gone.
#
# Modes:
#   export-order    - Fail if any packages/*/package.json exports object lists
#                     "types" after "import" or "require" (tsup/esbuild warns
#                     about an unreachable types condition in that case).
#   targeted-builds - Run the targeted builds named in the acceptance criteria
#                     and fail if any of them prints an unreachable types
#                     condition warning.
#   run-sh          - Fail if the active Electron launcher (run.sh) or
#                     verify-executor-routing.sh still references the removed
#                     @invoker/executors package as a build filter.
#
# Usage: bash scripts/verify-build-warning-clean.sh <mode>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 64
fi

check_export_order() {
  local fail=0
  local report
  report="$(
    python3 - <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(".")
violations = []
for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"{pkg_json}: failed to parse JSON ({exc})", file=sys.stderr)
        sys.exit(2)
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    for export_key, entry in exports.items():
        if not isinstance(entry, dict):
            continue
        keys = list(entry.keys())
        if "types" not in keys:
            continue
        types_idx = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < types_idx:
                violations.append(
                    f"{pkg_json}: exports[{export_key!r}] has 'types' after '{cond}'"
                )
                break
for line in violations:
    print(line)
sys.exit(1 if violations else 0)
PY
  )" || fail=$?

  if [[ -n "$report" ]]; then
    printf '%s\n' "$report"
  fi

  if [[ "$fail" -ne 0 ]]; then
    echo "FAIL: export-order: package.json exports must list 'types' before 'import'/'require'" >&2
    return 1
  fi

  echo "PASS: export-order: every packages/*/package.json exports object lists 'types' first"
  return 0
}

check_run_sh() {
  local fail=0
  local files=(
    "run.sh"
    "scripts/verify-executor-routing.sh"
  )
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL: run-sh: expected $f to exist" >&2
      fail=1
      continue
    fi
    local hits
    hits="$(grep -nE '@invoker/executors([^-]|$)' "$f" || true)"
    if [[ -n "$hits" ]]; then
      echo "FAIL: run-sh: $f still references @invoker/executors:" >&2
      printf '%s\n' "$hits" >&2
      fail=1
    fi
  done

  if [[ "$fail" -ne 0 ]]; then
    return 1
  fi

  echo "PASS: run-sh: launcher scripts no longer reference @invoker/executors"
  return 0
}

check_targeted_builds() {
  local fail=0
  local pkgs=(
    "@invoker/core"
    "@invoker/persistence"
    "@invoker/app"
  )
  local log
  log="$(mktemp -t invoker-build-warning.XXXXXX)"
  trap 'rm -f "$log"' RETURN

  for pkg in "${pkgs[@]}"; do
    echo "==> Building $pkg" >&2
    if ! pnpm --filter "$pkg" build >"$log" 2>&1; then
      echo "FAIL: targeted-builds: pnpm --filter $pkg build exited nonzero" >&2
      cat "$log" >&2
      fail=1
      continue
    fi
    if grep -E '"types" condition.*unreachable|unreachable.*"types" condition' "$log" >/dev/null; then
      echo "FAIL: targeted-builds: $pkg emitted an unreachable 'types' condition warning" >&2
      grep -nE '"types" condition.*unreachable|unreachable.*"types" condition' "$log" >&2 || true
      fail=1
    fi
  done

  if [[ "$fail" -ne 0 ]]; then
    return 1
  fi

  echo "PASS: targeted-builds: @invoker/core, @invoker/persistence, @invoker/app build without 'types' condition warnings"
  return 0
}

case "$MODE" in
  export-order)
    check_export_order
    ;;
  run-sh)
    check_run_sh
    ;;
  targeted-builds)
    check_targeted_builds
    ;;
  *)
    echo "unknown mode: $MODE (expected export-order|targeted-builds|run-sh)" >&2
    exit 64
    ;;
esac
