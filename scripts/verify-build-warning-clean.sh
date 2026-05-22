#!/usr/bin/env bash
# Verify the run.sh / targeted build path is free of the export-condition and
# stale-filter warnings that previously polluted the build log.
#
# Modes:
#   export-order     - assert every packages/*/package.json export object lists
#                      "types" before "import" and "require"
#   targeted-builds  - run pnpm --filter ... build for core/persistence/app and
#                      fail if tsup/esbuild emits an unreachable "types"
#                      condition warning
#   run-sh           - assert run.sh and active helper scripts do not reference
#                      the removed @invoker/executors package as a build filter
#
# Each mode exits 0 on pass, nonzero on fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 64
fi

check_export_order() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const dir = path.join(root, "packages");
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
      const pkgPath = path.join(dir, name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
      catch (e) { offenders.push(`${pkgPath}: invalid JSON (${e.message})`); continue; }
      const exp = pkg.exports;
      if (!exp || typeof exp !== "object") continue;
      const walk = (node, where) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const keys = Object.keys(node);
        const ti = keys.indexOf("types");
        const ii = keys.indexOf("import");
        const ri = keys.indexOf("require");
        if (ti > -1 && ((ii > -1 && ti > ii) || (ri > -1 && ti > ri))) {
          offenders.push(`${pkgPath} :: ${where} -> [${keys.join(", ")}]`);
        }
        for (const k of keys) walk(node[k], `${where}.${k}`);
      };
      walk(exp, "exports");
    }
    if (offenders.length) {
      console.error("FAIL: exports condition order — types must precede import/require:");
      for (const o of offenders) console.error("  " + o);
      process.exit(1);
    }
    console.log("PASS: every workspace export object lists \"types\" before \"import\"/\"require\".");
  ' "$ROOT"
}

check_targeted_builds() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local filters=(@invoker/core @invoker/persistence @invoker/app)
  local rc=0
  for filter in "${filters[@]}"; do
    echo "==> pnpm --filter $filter build" >&2
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: build failed for $filter" >&2
      cat "$log" >&2
      rc=1
      break
    fi
  done

  if [ $rc -eq 0 ]; then
    # tsup/esbuild emits this exact phrasing when a later condition can never
    # match because an earlier one already does.
    if grep -E -i 'unreachable.*"?types"? condition|"types".*condition.*unreachable' "$log" >/dev/null; then
      echo "FAIL: build log contains an unreachable \"types\" condition warning:" >&2
      grep -E -i 'unreachable.*"?types"? condition|"types".*condition.*unreachable' "$log" >&2
      rc=1
    fi
  fi

  if [ $rc -eq 0 ]; then
    echo "PASS: targeted builds emitted no unreachable \"types\" condition warnings."
  fi
  return $rc
}

check_run_sh() {
  local pattern='(^|[[:space:]])--filter[[:space:]]+@invoker/executors([[:space:]]|$|")'
  local offenders=()
  for f in run.sh scripts/verify-executor-routing.sh; do
    if [ ! -f "$f" ]; then continue; fi
    if grep -E -n -e "$pattern" "$f" >/dev/null; then
      offenders+=("$f")
    fi
  done

  if [ ${#offenders[@]} -ne 0 ]; then
    echo "FAIL: active launcher scripts still filter the removed @invoker/executors package:" >&2
    for f in "${offenders[@]}"; do
      grep -E -n -e "$pattern" "$f" >&2 || true
      echo "  -> $f" >&2
    done
    return 1
  fi
  echo "PASS: no active launcher script references @invoker/executors as a build filter."
}

case "$MODE" in
  export-order)    check_export_order ;;
  targeted-builds) check_targeted_builds ;;
  run-sh)          check_run_sh ;;
  *)
    echo "unknown mode: $MODE" >&2
    echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
    exit 64
    ;;
esac
