#!/usr/bin/env bash
# Verify that build/launch warnings from stale package metadata are clean.
#
# Modes:
#   export-order    — every packages/*/package.json export object lists
#                     `types` before `import`/`require` (silences the
#                     tsup/esbuild "condition \"types\" here will never be
#                     used" warning).
#   targeted-builds — `pnpm --filter` builds for @invoker/core,
#                     @invoker/persistence, and @invoker/app produce no
#                     unreachable-condition warnings.
#   run-sh          — active launcher/helper scripts (run.sh and
#                     scripts/verify-executor-routing.sh) do not reference
#                     the stale `@invoker/executors` package filter, which
#                     causes pnpm to print "No projects matched the filters".
#
# Each mode exits 0 on pass and nonzero when the warning marker is detected.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
usage() {
  echo "Usage: $0 {export-order|targeted-builds|run-sh}" >&2
}
if [[ -z "$MODE" ]]; then
  usage
  exit 2
fi

case "$MODE" in
  export-order)
    python3 - <<'PY'
import glob, json, sys

fails = []
for path in sorted(glob.glob('packages/*/package.json')):
    with open(path, 'r', encoding='utf-8') as fh:
        pkg = json.load(fh)
    exports = pkg.get('exports')
    if not isinstance(exports, dict):
        continue
    for subpath, value in exports.items():
        if not isinstance(value, dict):
            continue
        keys = list(value.keys())
        if 'types' not in keys:
            continue
        types_idx = keys.index('types')
        for cond in ('import', 'require'):
            if cond in keys and keys.index(cond) < types_idx:
                fails.append(f"{path} export '{subpath}': 'types' listed after '{cond}'")
                break

if fails:
    print("FAIL: workspace export objects have 'types' after 'import'/'require':", file=sys.stderr)
    for line in fails:
        print(f"  - {line}", file=sys.stderr)
    sys.exit(1)

print("PASS: every workspace export object lists 'types' before 'import'/'require'")
PY
    ;;
  targeted-builds)
    LOG="$(mktemp)"
    trap 'rm -f "$LOG"' EXIT
    rc=0
    # Regex pattern matches the esbuild/tsup warning about a "types"
    # condition that is unreachable because it follows "import"/"require".
    WARN_REGEX='condition "types" here will never be used|"types" condition[^"]* will never be used|unreachable.*\btypes\b condition'
    for pkg in @invoker/core @invoker/persistence @invoker/app; do
      echo "==> building $pkg" >&2
      if ! pnpm --filter "$pkg" build >"$LOG" 2>&1; then
        cat "$LOG" >&2
        echo "FAIL: build of $pkg exited nonzero" >&2
        rc=1
        continue
      fi
      cat "$LOG" >&2
      if grep -Eq "$WARN_REGEX" "$LOG"; then
        echo "FAIL: $pkg build emitted unreachable 'types' condition warning" >&2
        rc=1
      fi
    done
    if [[ "$rc" -eq 0 ]]; then
      echo "PASS: targeted builds produced no unreachable 'types' condition warnings"
    fi
    exit "$rc"
    ;;
  run-sh)
    STALE_FILTER='@invoker/executors'
    SCRIPTS=("run.sh" "scripts/verify-executor-routing.sh")
    fails=()
    for f in "${SCRIPTS[@]}"; do
      if [[ ! -f "$f" ]]; then
        continue
      fi
      if grep -q -- "$STALE_FILTER" "$f"; then
        fails+=("$f")
      fi
    done
    if (( ${#fails[@]} > 0 )); then
      echo "FAIL: active launcher/helper scripts still reference $STALE_FILTER:" >&2
      for f in "${fails[@]}"; do
        echo "  - $f" >&2
      done
      exit 1
    fi
    echo "PASS: run.sh and scripts/verify-executor-routing.sh no longer filter on $STALE_FILTER"
    ;;
  *)
    usage
    exit 2
    ;;
esac
