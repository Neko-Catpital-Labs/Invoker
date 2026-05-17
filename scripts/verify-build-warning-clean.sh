#!/usr/bin/env bash
# Verify that the noisy build warnings introduced by stale launcher
# filters and out-of-order export conditions are gone.
#
# Modes:
#   export-order    Scan every packages/*/package.json exports object and
#                   fail if any subpath conditions list "types" after
#                   "import" or "require" (the tsup/esbuild "unreachable
#                   condition" trigger).
#   targeted-builds Run the three targeted builds that drove the
#                   regression (@invoker/core, @invoker/persistence,
#                   @invoker/app) and fail if their combined output
#                   contains the "types" unreachable-condition warning.
#   run-sh          Grep the active build/filter lines in run.sh and
#                   scripts/verify-executor-routing.sh and fail if any
#                   `pnpm --filter @invoker/executors` invocation
#                   survives — that is the launcher path pnpm reports as
#                   "No projects matched the filters".
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh <mode>
set -euo pipefail

MODE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$MODE" ]]; then
  echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 2
fi

case "$MODE" in
  export-order)
    cd "$ROOT"
    node -e '
      const fs = require("fs");
      const path = require("path");
      const pkgRoot = path.join(process.cwd(), "packages");
      const names = fs.readdirSync(pkgRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const problems = [];
      for (const name of names) {
        const pkgPath = path.join(pkgRoot, name, "package.json");
        if (!fs.existsSync(pkgPath)) continue;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const exp = pkg.exports;
        if (!exp || typeof exp !== "object") continue;
        const visit = (label, value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return;
          const keys = Object.keys(value);
          const t = keys.indexOf("types");
          if (t === -1) return;
          const im = keys.indexOf("import");
          const rq = keys.indexOf("require");
          if ((im !== -1 && t > im) || (rq !== -1 && t > rq)) {
            problems.push(`${pkgPath} exports[${label}]: condition order is ${JSON.stringify(keys)} (types must come before import/require)`);
          }
        };
        for (const key of Object.keys(exp)) {
          visit(JSON.stringify(key), exp[key]);
        }
      }
      if (problems.length > 0) {
        console.error("FAIL: export condition ordering would emit tsup/esbuild unreachable-types warnings:");
        for (const p of problems) console.error("  - " + p);
        process.exit(1);
      }
      console.log("PASS: every packages/*/package.json export object lists \"types\" before \"import\"/\"require\".");
    '
    ;;
  targeted-builds)
    cd "$ROOT"
    LOG="$(mktemp "${TMPDIR:-/tmp}/verify-build-warning-clean.XXXXXX.log")"
    trap 'rm -f "$LOG"' EXIT
    set +e
    pnpm --filter @invoker/core build >>"$LOG" 2>&1
    rc_core=$?
    pnpm --filter @invoker/persistence build >>"$LOG" 2>&1
    rc_pers=$?
    pnpm --filter @invoker/app build >>"$LOG" 2>&1
    rc_app=$?
    set -e
    if [[ $rc_core -ne 0 || $rc_pers -ne 0 || $rc_app -ne 0 ]]; then
      echo "FAIL: targeted build(s) returned nonzero (core=$rc_core persistence=$rc_pers app=$rc_app)" >&2
      cat "$LOG" >&2
      exit 1
    fi
    if grep -E -n '"types" condition.*will never be used|unreachable .*"types" condition' "$LOG" >/dev/null; then
      echo "FAIL: tsup/esbuild emitted unreachable \"types\" condition warning(s):" >&2
      grep -E -n '"types" condition.*will never be used|unreachable .*"types" condition' "$LOG" >&2
      exit 1
    fi
    echo "PASS: @invoker/core, @invoker/persistence, @invoker/app built with no unreachable \"types\" condition warning."
    ;;
  run-sh)
    bad=0
    for f in "$ROOT/run.sh" "$ROOT/scripts/verify-executor-routing.sh"; do
      if [[ ! -f "$f" ]]; then
        echo "FAIL: expected launcher script missing: $f" >&2
        bad=1
        continue
      fi
      # Only inspect active `pnpm --filter` invocations — comments may
      # still describe the historical name.
      if grep -E -n '^[^#]*pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors\b' "$f" >/dev/null; then
        echo "FAIL: $f still calls 'pnpm --filter @invoker/executors' (pnpm reports 'No projects matched the filters'):" >&2
        grep -E -n '^[^#]*pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors\b' "$f" >&2
        bad=1
      fi
    done
    if [[ $bad -ne 0 ]]; then
      exit 1
    fi
    echo "PASS: run.sh and scripts/verify-executor-routing.sh no longer filter on the removed @invoker/executors package."
    ;;
  *)
    echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
    exit 2
    ;;
esac
