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
#                    no longer use the removed `@invoker/executors` package
#                    filter, and that their active build filters do not produce
#                    the `No projects matched the filters` launcher warning.
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
stats = {"inspected": 0}


def export_path(segments):
    return "exports" + "".join(f"[{segment!r}]" for segment in segments)


def inspect_export_object(pkg_json, segments, entry):
    if not isinstance(entry, dict):
        return

    keys = list(entry.keys())
    if any(cond in keys for cond in ("types", "import", "require")):
        stats["inspected"] += 1
        if "types" in keys:
            types_idx = keys.index("types")
            for cond in ("import", "require"):
                if cond in keys and keys.index(cond) < types_idx:
                    problems.append(
                        f"{pkg_json}: {export_path(segments)} orders 'types' after '{cond}'"
                    )
                    break

    for key, value in entry.items():
        if isinstance(value, dict):
            inspect_export_object(pkg_json, segments + [key], value)

for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        problems.append(f"{pkg_json}: invalid JSON ({exc})")
        continue
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    inspect_export_object(pkg_json, [], exports)

if problems:
    print("FAIL: unreachable 'types' export conditions found:", file=sys.stderr)
    for line in problems:
        print(f"  - {line}", file=sys.stderr)
    sys.exit(1)

print(f"PASS: export-order ({stats['inspected']} export object(s) inspected)")
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

  local warning_pattern='condition[[:space:]]+"types"[[:space:]]+here will never be used|"types".*(unreachable|will never be used|never be used)|unreachable.*"types"'
  if grep -E -i "$warning_pattern" "$log" >/dev/null; then
    echo "FAIL: targeted-builds emitted unreachable 'types' condition warnings:" >&2
    grep -E -i -n "$warning_pattern" "$log" >&2 || true
    return 1
  fi

  echo "PASS: targeted-builds (no unreachable 'types' condition warnings)"
}

verify_run_sh() {
  local paths=(run.sh scripts/verify-executor-routing.sh)
  local path
  for path in "${paths[@]}"; do
    if [[ ! -f "$path" ]]; then
      echo "FAIL: expected script missing: $path" >&2
      return 1
    fi
  done

  local stale_filters
  stale_filters="$(
    awk '
      /^[[:space:]]*#/ { next }
      {
        for (i = 1; i <= NF - 2; i++) {
          if ($i == "--filter" && $(i + 1) == "@invoker/executors" && $(i + 2) == "build") {
            print FILENAME ":" FNR ":" $0
          }
        }
      }
    ' "${paths[@]}"
  )"
  if [[ -n "$stale_filters" ]]; then
    echo "FAIL: active launcher build filters still reference removed '@invoker/executors':" >&2
    printf '%s\n' "$stale_filters" >&2
    return 1
  fi

  local filters
  mapfile -t filters < <(
    awk '
      /^[[:space:]]*#/ { next }
      {
        for (i = 1; i <= NF - 2; i++) {
          if ($i == "--filter" && $(i + 1) ~ /^@invoker\// && $(i + 2) == "build") {
            print $(i + 1)
          }
        }
      }
    ' "${paths[@]}" | sort -u
  )

  if (( ${#filters[@]} == 0 )); then
    echo "FAIL: no active package build filters found in launcher scripts" >&2
    return 1
  fi

  local log
  log="$(mktemp "${TMPDIR:-/tmp}/invoker-run-sh-filter.XXXXXX")"
  trap 'rm -f "$log"' RETURN

  local filter
  for filter in "${filters[@]}"; do
    if ! pnpm --filter "$filter" exec node -e "" >>"$log" 2>&1; then
      echo "FAIL: unable to validate launcher build filter $filter" >&2
      cat "$log" >&2
      return 1
    fi
  done

  if grep -F 'No projects matched the filters' "$log" >/dev/null; then
    echo "FAIL: run-sh validation emitted 'No projects matched the filters':" >&2
    grep -F -n 'No projects matched the filters' "$log" >&2 || true
    return 1
  fi

  echo "PASS: run-sh (no stale filters and no 'No projects matched the filters' warnings)"
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
