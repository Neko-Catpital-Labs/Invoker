#!/usr/bin/env bash
# Verify that the build pipeline is free of two known noise sources:
#
#   1. tsup/esbuild "Cannot resolve" / "unreachable" warnings for the `types`
#      condition in package exports (caused by `types` being placed after
#      `import` / `require` in an export object).
#   2. The launcher `No projects matched the filters` warning emitted when
#      `run.sh` / helper scripts target the stale `@invoker/executors`
#      workspace filter.
#
# Modes:
#   export-order    Lint every workspace package.json export object: `types`
#                   must come before `import` and `require`.
#   targeted-builds Run the three targeted package builds named in the plan
#                   (`@invoker/core`, `@invoker/persistence`, `@invoker/app`)
#                   and fail if the unreachable-types warning marker appears.
#   run-sh          Grep active launcher / helper scripts for the stale
#                   `@invoker/executors` filter.
#
# Each mode exits 0 on pass and nonzero when the relevant warning markers
# are present.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/verify-build-warning-clean.sh <mode>
  mode := export-order | targeted-builds | run-sh
EOF
}

mode="${1:-}"
if [[ -z "$mode" ]]; then
  usage
  exit 2
fi

run_export_order() {
  # Walk every workspace package.json and confirm any exports condition object
  # places `types` before `import` and `require`. JSON key order is preserved
  # by python's json module, which is what node's resolver actually consumes.
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
violations = []

def check_conditions(pkg_path, export_key, conditions):
    if not isinstance(conditions, dict):
        return
    keys = list(conditions.keys())
    if "types" not in keys:
        return
    types_idx = keys.index("types")
    for cond in ("import", "require"):
        if cond in keys and keys.index(cond) < types_idx:
            violations.append(
                f"{pkg_path}: exports[{export_key!r}] has '{cond}' before 'types' ({keys})"
            )
            return

for pkg_json in sorted((root / "packages").glob("*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        violations.append(f"{pkg_json}: invalid JSON ({exc})")
        continue
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    # exports may be a single condition map ({"import": ..., "types": ...})
    # or a subpath map ({".": {...}, "./foo": {...}}).
    if any(isinstance(v, dict) for v in exports.values()):
        for sub_key, sub_val in exports.items():
            check_conditions(pkg_json, sub_key, sub_val)
    else:
        check_conditions(pkg_json, ".", exports)

if violations:
    print("FAIL: package.json export condition order violations:", file=sys.stderr)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    sys.exit(1)

print("PASS: every workspace exports object has 'types' before 'import'/'require'.")
PY
}

run_targeted_builds() {
  local log
  log="$(mktemp -t invoker-build-warning.XXXXXX)"
  trap 'rm -f "$log"' RETURN

  local rc=0
  for filter in "@invoker/core" "@invoker/persistence" "@invoker/app"; do
    echo "==> Building $filter" >&2
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      rc=1
    fi
  done

  # esbuild/tsup phrases used when a condition (e.g. `types`) is shadowed by
  # an earlier matching condition in the same exports map.
  if grep -E -i 'unreachable.*"types"|"types" .*unreachable|conditions .*"types".*never|will never be used' "$log" >/dev/null; then
    echo "FAIL: targeted builds emitted unreachable-types warnings:" >&2
    grep -E -i 'unreachable.*"types"|"types" .*unreachable|conditions .*"types".*never|will never be used' "$log" >&2
    return 1
  fi

  if [[ $rc -ne 0 ]]; then
    echo "FAIL: a targeted build exited nonzero (see log above)." >&2
    cat "$log" >&2
    return $rc
  fi

  echo "PASS: targeted builds (@invoker/core, @invoker/persistence, @invoker/app) emitted no unreachable-types warnings."
}

run_run_sh() {
  # Active launcher/helper surfaces that must no longer reference the stale
  # `@invoker/executors` filter (the package has been removed; the live name
  # is `@invoker/execution-engine`).
  local scripts=(
    "$ROOT/run.sh"
    "$ROOT/scripts/verify-executor-routing.sh"
  )

  local hits=()
  for f in "${scripts[@]}"; do
    if [[ ! -f "$f" ]]; then
      continue
    fi
    if grep -nE 'pnpm[[:space:]]+(-r[[:space:]]+)?--filter[[:space:]]+@invoker/executors\b' "$f" >/dev/null; then
      while IFS= read -r line; do
        hits+=("$f:$line")
      done < <(grep -nE 'pnpm[[:space:]]+(-r[[:space:]]+)?--filter[[:space:]]+@invoker/executors\b' "$f")
    fi
  done

  if [[ ${#hits[@]} -gt 0 ]]; then
    echo "FAIL: active launcher scripts still target @invoker/executors:" >&2
    for h in "${hits[@]}"; do
      echo "  - $h" >&2
    done
    return 1
  fi

  echo "PASS: no active launcher/helper script references @invoker/executors."
}

case "$mode" in
  export-order)    run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh)          run_run_sh ;;
  *)
    usage
    exit 2
    ;;
esac
