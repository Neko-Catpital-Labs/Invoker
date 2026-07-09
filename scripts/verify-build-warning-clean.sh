#!/usr/bin/env bash
# Verify that the tsup/esbuild "unreachable `types` condition" warnings and
# the `No projects matched the filters` launcher warning stay fixed.
#
# Modes:
#   export-order     Inspect every packages/*/package.json and fail if any
#                    exports map orders `types` after `import` or `require`.
#   targeted-builds  Run the three targeted builds called out by the task
#                    (`@invoker/core`, `@invoker/persistence`, `@invoker/app`)
#                    and fail if their combined output mentions an unreachable
#                    `types` condition.
#   run-sh           Assert that `run.sh` and `scripts/verify-executor-routing.sh`
#                    no longer reference the removed `@invoker/executors` package
#                    filter (which is what produced the
#                    `No projects matched the filters` launcher warning).
#
# Each mode exits 0 on pass and nonzero on fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 2
fi

verify_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
problems = []
inspected = 0

for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        problems.append(f"{pkg_json}: invalid JSON ({exc})")
        continue
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    for subpath, entry in exports.items():
        if not isinstance(entry, dict):
            continue
        inspected += 1
        keys = list(entry.keys())
        if "types" not in keys:
            continue
        types_idx = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < types_idx:
                problems.append(
                    f"{pkg_json}: exports[{subpath!r}] orders 'types' after '{cond}'"
                )
                break

if problems:
    print("FAIL: unreachable 'types' export conditions found:", file=sys.stderr)
    for line in problems:
        print(f"  - {line}", file=sys.stderr)
    sys.exit(1)

print(f"PASS: export-order ({inspected} export object(s) inspected)")
PY
}

verify_targeted_builds() {
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/invoker-build-warn.XXXXXX")"
  trap 'rm -f "$log"' RETURN

  local filters=(@invoker/core @invoker/persistence @invoker/app)
  for filter in "${filters[@]}"; do
    echo "==> pnpm --filter $filter build"
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: build for $filter exited nonzero" >&2
      cat "$log" >&2
      return 1
    fi
  done

  if grep -E -i '("types"[^\n]*(unreachable|will never be used|never be used))|(unreachable[^\n]*"types")' "$log" >/dev/null; then
    echo "FAIL: targeted-builds emitted unreachable 'types' condition warnings:" >&2
    grep -E -i -n '("types"[^\n]*(unreachable|will never be used|never be used))|(unreachable[^\n]*"types")' "$log" >&2 || true
    return 1
  fi

  echo "PASS: targeted-builds (no unreachable 'types' condition warnings)"
}

verify_run_sh() {
  local hits=0
  for path in run.sh scripts/verify-executor-routing.sh; do
    if [[ ! -f "$path" ]]; then
      echo "FAIL: expected script missing: $path" >&2
      return 1
    fi
    if grep -n -F '@invoker/executors' "$path" >/dev/null; then
      echo "FAIL: $path still references the removed '@invoker/executors' filter:" >&2
      grep -n -F '@invoker/executors' "$path" >&2 || true
      hits=$((hits + 1))
    fi
  done
  if (( hits > 0 )); then
    return 1
  fi
  echo "PASS: run-sh (no stale '@invoker/executors' build filters)"
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
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 <export-order|targeted-builds|run-sh>" >&2
    exit 2
    ;;
esac
