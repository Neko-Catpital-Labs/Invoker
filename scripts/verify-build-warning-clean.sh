#!/usr/bin/env bash
# Verify that workspace build configuration does not emit known noisy warnings:
#
#   export-order    — Every workspace package.json `exports` entry must list
#                     the `types` condition before `import` and `require`,
#                     so tsup/esbuild do not log the unreachable-condition
#                     warning that appears when `types` comes after either.
#
#   targeted-builds — Runs `pnpm --filter <pkg> build` for the headless build
#                     critical path and fails if the build log contains the
#                     tsup/esbuild unreachable `types` condition warning.
#
#   run-sh         — Inspects run.sh and active helper scripts for stale
#                    `@invoker/<pkg>` filters that no longer match a workspace
#                    package. When pnpm sees an unknown filter it prints
#                    "No projects matched the filters", which is the marker
#                    we want to keep out of the launch log.
#
# Each mode exits 0 on pass and nonzero when the relevant warning markers
# are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "usage: $0 <export-order|targeted-builds|run-sh>" >&2
  exit 2
fi

# Marker substrings the script greps for. Kept narrow on purpose so unrelated
# tsup chatter (build duration, dts emit lines) cannot trigger a false fail.
TYPES_WARNING_MARKER='The condition "types"'
NO_PROJECTS_MARKER='No projects matched the filters'

check_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
bad = []
for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text())
    except json.JSONDecodeError as exc:
        print(f"FAIL: cannot parse {pkg_json}: {exc}", file=sys.stderr)
        sys.exit(1)
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    for entry_key, entry in exports.items():
        if not isinstance(entry, dict):
            continue
        keys = list(entry.keys())
        if "types" not in keys:
            continue
        ti = keys.index("types")
        for cond in ("import", "require"):
            if cond in keys and keys.index(cond) < ti:
                bad.append(f"{pkg_json.relative_to(root)} {entry_key}: 'types' after '{cond}' (order: {keys})")
                break

if bad:
    print("FAIL: workspace export maps with 'types' after 'import'/'require':", file=sys.stderr)
    for line in bad:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

print("PASS: all workspace export maps list 'types' before 'import'/'require'")
PY
}

check_targeted_builds() {
  local pkgs=(@invoker/core @invoker/persistence @invoker/app)
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local failed=0
  for pkg in "${pkgs[@]}"; do
    echo "==> pnpm --filter $pkg build"
    if ! pnpm --filter "$pkg" build >"$log" 2>&1; then
      cat "$log" >&2
      echo "FAIL: build for $pkg exited nonzero" >&2
      failed=1
      continue
    fi
    if grep -F -- "$TYPES_WARNING_MARKER" "$log" >/dev/null; then
      grep -F -- "$TYPES_WARNING_MARKER" "$log" >&2 || true
      echo "FAIL: $pkg build emitted unreachable 'types' condition warning" >&2
      failed=1
    fi
    if grep -F -- "$NO_PROJECTS_MARKER" "$log" >/dev/null; then
      grep -F -- "$NO_PROJECTS_MARKER" "$log" >&2 || true
      echo "FAIL: $pkg build emitted 'No projects matched the filters' warning" >&2
      failed=1
    fi
  done

  if [ "$failed" -ne 0 ]; then
    return 1
  fi
  echo "PASS: targeted builds emitted no unreachable 'types' or stale-filter warnings"
}

check_run_sh() {
  local scripts=("$ROOT/run.sh" "$ROOT/scripts/verify-executor-routing.sh")
  local pkg_names
  pkg_names="$(python3 - "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
names = []
for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text())
    except json.JSONDecodeError:
        continue
    name = data.get("name")
    if isinstance(name, str):
        names.append(name)
print("\n".join(names))
PY
)"

  local failed=0
  for script in "${scripts[@]}"; do
    if [ ! -f "$script" ]; then
      continue
    fi
    while IFS= read -r line; do
      filter="$(printf '%s' "$line" | sed -E 's/.*--filter[[:space:]]+([@A-Za-z0-9_/.-]+).*/\1/')"
      if [ -z "$filter" ] || [ "$filter" = "$line" ]; then
        continue
      fi
      if ! printf '%s\n' "$pkg_names" | grep -Fx -- "$filter" >/dev/null; then
        echo "FAIL: $script references unknown workspace filter '$filter'" >&2
        echo "      line: $line" >&2
        failed=1
      fi
    done < <(grep -E 'pnpm[[:space:]]+--filter[[:space:]]+@invoker/' "$script" || true)
  done

  if [ "$failed" -ne 0 ]; then
    return 1
  fi
  echo "PASS: launcher scripts reference only existing workspace packages"
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
