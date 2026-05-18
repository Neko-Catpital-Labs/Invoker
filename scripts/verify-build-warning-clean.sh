#!/usr/bin/env bash
# Verify package metadata and launcher scripts no longer trigger build warnings.
#
# Modes:
#   export-order    — fail if any packages/*/package.json exports object lists
#                     "types" after "import" or "require" (the ordering that
#                     makes esbuild/tsup emit the unreachable-condition warning).
#   targeted-builds — run @invoker/core, @invoker/persistence, @invoker/app
#                     builds and fail if their combined output contains the
#                     unreachable "types" condition warning marker.
#   run-sh          — fail if run.sh or scripts/verify-executor-routing.sh
#                     still references the stale "@invoker/executors" filter
#                     (which would cause pnpm to print
#                     "No projects matched the filters").
#
# Each mode exits 0 on pass, nonzero on fail.
set -euo pipefail

mode="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 2
}

case "$mode" in
  export-order)
    node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const root = process.argv[1];
const pkgsDir = path.join(root, "packages");
const violations = [];
function walk(node, file, location) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const keys = Object.keys(node);
  if (keys.includes("types")) {
    const typesIdx = keys.indexOf("types");
    for (const cond of ["import", "require"]) {
      const idx = keys.indexOf(cond);
      if (idx !== -1 && idx < typesIdx) {
        violations.push(`${file}: exports[${location}] lists "types" after "${cond}"`);
        break;
      }
    }
  }
  for (const [k, v] of Object.entries(node)) {
    walk(v, file, `${location}.${k}`);
  }
}
for (const dir of fs.readdirSync(pkgsDir)) {
  const pj = path.join(pkgsDir, dir, "package.json");
  if (!fs.existsSync(pj)) continue;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
  } catch (err) {
    console.error(`failed to parse ${pj}: ${err.message}`);
    process.exit(1);
  }
  if (parsed.exports && typeof parsed.exports === "object") {
    walk(parsed.exports, path.relative(root, pj), "");
  }
}
if (violations.length > 0) {
  for (const v of violations) console.error(`FAIL: ${v}`);
  process.exit(1);
}
console.log("PASS: all packages/*/package.json exports list \"types\" before \"import\"/\"require\"");
' "$ROOT"
    ;;
  targeted-builds)
    cd "$ROOT"
    log="$(mktemp)"
    trap 'rm -f "$log"' EXIT
    for filter in @invoker/core @invoker/persistence @invoker/app; do
      echo "==> pnpm --filter $filter build" >&2
      if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
        echo "FAIL: build failed for $filter" >&2
        cat "$log" >&2
        exit 1
      fi
    done
    if grep -F '"types"' "$log" | grep -Eq 'never|unreachable'; then
      echo "FAIL: unreachable \"types\" condition warning detected:" >&2
      grep -F '"types"' "$log" | grep -E 'never|unreachable' >&2 || true
      exit 1
    fi
    echo "PASS: targeted builds emitted no unreachable \"types\" condition warnings"
    ;;
  run-sh)
    cd "$ROOT"
    fail=0
    for f in run.sh scripts/verify-executor-routing.sh; do
      if [ ! -f "$f" ]; then
        continue
      fi
      if grep -nF "@invoker/executors" "$f" >/dev/null 2>&1; then
        echo "FAIL: $f still references @invoker/executors" >&2
        grep -nF "@invoker/executors" "$f" >&2 || true
        fail=1
      fi
    done
    if [ "$fail" -ne 0 ]; then
      exit 1
    fi
    echo "PASS: launcher/helper scripts no longer reference @invoker/executors"
    ;;
  *)
    usage
    ;;
esac
