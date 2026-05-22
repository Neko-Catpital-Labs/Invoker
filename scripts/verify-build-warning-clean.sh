#!/usr/bin/env bash
# Verify that the build pipeline does not emit known noise warnings:
#   export-order   — every workspace package.json export object has `types`
#                    before `import` and `require` (tsup/esbuild flag the
#                    opposite ordering as an unreachable `types` condition).
#   targeted-builds — the three load-bearing targeted builds (@invoker/core,
#                    @invoker/persistence, @invoker/app) run clean of the
#                    "unreachable `types`" warning.
#   run-sh         — run.sh and scripts/verify-executor-routing.sh do not
#                    pass the stale @invoker/executors filter that produced
#                    "No projects matched the filters".
#
# Each mode exits 0 on pass and nonzero if any warning marker is detected.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 2
fi

verify_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
pkg_dir = root / "packages"
bad = []

def walk(path, exports):
    if isinstance(exports, dict):
        keys = list(exports.keys())
        if "types" in keys:
            idx_types = keys.index("types")
            for cond in ("import", "require"):
                if cond in keys and keys.index(cond) < idx_types:
                    bad.append((path, cond))
                    return
        for v in exports.values():
            walk(path, v)

for pkg in sorted(pkg_dir.glob("*/package.json")):
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL: {pkg} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(1)
    exports = data.get("exports")
    if exports:
        walk(pkg, exports)

if bad:
    for pkg, cond in bad:
        rel = pkg.relative_to(root)
        print(f"FAIL: {rel} lists `{cond}` before `types` in exports", file=sys.stderr)
    sys.exit(1)

print("PASS: all package.json export objects list `types` first")
PY
}

verify_targeted_builds() {
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/invoker-build-log.XXXXXX")"
  trap 'rm -f "$log"' RETURN

  local status=0
  cd "$ROOT"
  for filter in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> pnpm --filter $filter build"
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: build for $filter exited nonzero" >&2
      cat "$log" >&2
      return 1
    fi
  done

  if grep -E -i 'unreachable.*"types"|"types".*unreachable' "$log" >/dev/null; then
    echo "FAIL: targeted build log contains unreachable \`types\` condition warning" >&2
    grep -E -i 'unreachable.*"types"|"types".*unreachable' "$log" >&2 || true
    return 1
  fi

  echo "PASS: targeted builds produced no unreachable \`types\` warnings"
}

verify_run_sh() {
  local files=("$ROOT/run.sh" "$ROOT/scripts/verify-executor-routing.sh")
  local hits=0
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL: expected file missing: $f" >&2
      return 1
    fi
    if grep -nE '@invoker/executors\b' "$f" >/dev/null; then
      echo "FAIL: $f still references @invoker/executors:" >&2
      grep -nE '@invoker/executors\b' "$f" >&2
      hits=$((hits + 1))
    fi
  done
  if (( hits > 0 )); then
    return 1
  fi
  echo "PASS: launcher scripts no longer filter on @invoker/executors"
}

case "$mode" in
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
    echo "unknown mode: $mode" >&2
    echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
    exit 2
    ;;
esac
