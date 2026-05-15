#!/usr/bin/env bash
# Verify that the noisy build/launcher warnings called out in
# "normalize-package-export-conditions" stay fixed:
#
#   export-order    All workspace package.json export objects place `types`
#                   before `import`/`require` so tsup/esbuild stop emitting
#                   the unreachable `types` condition warning.
#   targeted-builds Run the documented targeted builds and grep their output
#                   for the unreachable-`types` warning marker.
#   run-sh          The active launcher/helper scripts must not invoke
#                   `pnpm --filter @invoker/executors`, which no longer
#                   resolves and triggers the "No projects matched the
#                   filters" warning.
#
# Each mode exits 0 on pass and nonzero (1) when the relevant warning
# markers are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'USAGE' >&2
Usage: verify-build-warning-clean.sh <mode>
Modes:
  export-order     Check packages/*/package.json export ordering (types first).
  targeted-builds  Run the targeted pnpm builds and scan for the unreachable
                   `types` condition warning.
  run-sh           Confirm active launchers do not filter the removed
                   @invoker/executors package.
USAGE
}

mode_export_order() {
  python3 - "$ROOT" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
violations = []
for pkg in sorted((root / 'packages').glob('*/package.json')):
    try:
        data = json.loads(pkg.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot parse {pkg}: {exc}", file=sys.stderr)
        sys.exit(2)
    exports = data.get('exports')
    if not isinstance(exports, dict):
        continue
    for sub, cond in exports.items():
        if not isinstance(cond, dict):
            continue
        keys = list(cond.keys())
        if 'types' not in keys:
            continue
        ti = keys.index('types')
        for other in ('import', 'require'):
            if other in keys and keys.index(other) < ti:
                violations.append(
                    f"{pkg.relative_to(root)} exports[{sub!r}] -> {other} appears before types ({keys})"
                )
if violations:
    print('FAIL: export condition order regressed:', file=sys.stderr)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    sys.exit(1)
print('PASS: every workspace exports object places `types` before `import`/`require`.')
PY
}

mode_targeted_builds() {
  cd "$ROOT"
  local log warn_re rc
  log="$(mktemp "${TMPDIR:-/tmp}/invoker-build-warning.XXXXXX.log")"
  # Patterns tsup/esbuild emit when the `types` condition is shadowed by an
  # earlier matching condition. We match each independently so future wording
  # tweaks still trip the guard.
  warn_re='("types" condition .* unreachable|unreachable .*"types" condition|condition "types" .* will never be used)'

  echo "==> pnpm --filter @invoker/core build"
  pnpm --filter @invoker/core build 2>&1 | tee -a "$log"
  echo "==> pnpm --filter @invoker/persistence build"
  pnpm --filter @invoker/persistence build 2>&1 | tee -a "$log"
  echo "==> pnpm --filter @invoker/app build"
  pnpm --filter @invoker/app build 2>&1 | tee -a "$log"

  rc=0
  if grep -E -i "$warn_re" "$log" >/dev/null; then
    echo "FAIL: targeted builds emitted unreachable \`types\` condition warnings:" >&2
    grep -E -i -n "$warn_re" "$log" >&2 || true
    rc=1
  else
    echo "PASS: targeted builds completed with no unreachable \`types\` condition warnings."
  fi
  rm -f "$log"
  return "$rc"
}

mode_run_sh() {
  local files=(
    "$ROOT/run.sh"
    "$ROOT/scripts/verify-executor-routing.sh"
  )
  local hits=0
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      continue
    fi
    # Active build filters look like: pnpm --filter @invoker/executors ...
    # We only flag lines that actually invoke pnpm against the stale package,
    # so unrelated comments mentioning it are tolerated.
    if grep -E -n '^[[:space:]]*[^#]*pnpm[[:space:]]+(-r[[:space:]]+)?--filter[[:space:]]+@invoker/executors\b' "$f" >&2; then
      echo "FAIL: $f still filters the removed @invoker/executors package." >&2
      hits=$((hits + 1))
    fi
  done
  if (( hits > 0 )); then
    return 1
  fi
  echo "PASS: no active launcher/helper script filters @invoker/executors."
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi
  case "$1" in
    export-order)    mode_export_order ;;
    targeted-builds) mode_targeted_builds ;;
    run-sh)          mode_run_sh ;;
    -h|--help|help)  usage ;;
    *)
      echo "Unknown mode: $1" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
