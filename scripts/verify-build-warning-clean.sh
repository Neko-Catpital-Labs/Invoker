#!/usr/bin/env bash
# Verify that workspace metadata and launcher scripts do not emit known
# noisy build warnings:
#   - export-order   : every workspace package.json export object must place
#                      `types` before `import` and `require` (otherwise tsup
#                      / esbuild prints "Conditions for '...' are never used"
#                      style warnings).
#   - targeted-builds: pnpm --filter @invoker/{core,persistence,app} build
#                      must not print "Conditions for ... never used"
#                      unreachable-condition warnings.
#   - run-sh         : active launcher/helper scripts must not reference the
#                      stale `@invoker/executors` package filter (which yields
#                      "No projects matched the filters" from pnpm).
#
# Exits 0 on pass, nonzero when the relevant warning markers are present.
set -euo pipefail

MODE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <mode>

Modes:
  export-order     Check packages/*/package.json export objects place
                   "types" before "import"/"require".
  targeted-builds  Run pnpm --filter @invoker/{core,persistence,app} build
                   and assert no unreachable "Conditions for ... never used"
                   warnings are emitted.
  run-sh           Check active launcher/helper scripts do not reference the
                   stale @invoker/executors filter.
EOF
}

check_export_order() {
  local violations
  violations="$(node -e '
    const fs = require("fs");
    const path = require("path");
    const pkgsDir = path.join(process.cwd(), "packages");
    if (!fs.existsSync(pkgsDir)) {
      process.exit(0);
    }
    const violations = [];
    for (const entry of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(pkgsDir, entry.name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      } catch (err) {
        violations.push(pkgPath + ": invalid JSON (" + err.message + ")");
        continue;
      }
      const exportsField = pkg.exports;
      if (!exportsField || typeof exportsField !== "object") continue;
      const visit = (node, trail) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const keys = Object.keys(node);
        const typesIdx = keys.indexOf("types");
        if (typesIdx > -1) {
          const importIdx = keys.indexOf("import");
          const requireIdx = keys.indexOf("require");
          if ((importIdx > -1 && importIdx < typesIdx) ||
              (requireIdx > -1 && requireIdx < typesIdx)) {
            violations.push(pkgPath + " @ " + (trail.join(".") || ".") +
              " (order: " + keys.join(",") + ")");
            return;
          }
        }
        for (const k of keys) {
          visit(node[k], trail.concat(k));
        }
      };
      visit(exportsField, []);
    }
    if (violations.length) {
      console.log(violations.join("\n"));
      process.exit(1);
    }
  ')" || {
    echo "FAIL: package.json export maps must order 'types' before 'import'/'require':" >&2
    printf '%s\n' "$violations" >&2
    return 1
  }
  echo "PASS: workspace export maps order 'types' before 'import'/'require'."
}

check_run_sh() {
  local targets=(run.sh scripts/verify-executor-routing.sh)
  local hits=()
  for f in "${targets[@]}"; do
    [[ -f "$ROOT/$f" ]] || continue
    if grep -nE '@invoker/executors([^-]|$)' "$ROOT/$f" >/dev/null 2>&1; then
      while IFS= read -r line; do
        hits+=("$f:$line")
      done < <(grep -nE '@invoker/executors([^-]|$)' "$ROOT/$f")
    fi
  done
  if (( ${#hits[@]} > 0 )); then
    echo "FAIL: active launcher/helper scripts still reference stale @invoker/executors filter:" >&2
    printf '  %s\n' "${hits[@]}" >&2
    return 1
  fi
  echo "PASS: active launcher/helper scripts do not reference @invoker/executors."
}

check_targeted_builds() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN
  local status=0
  for filter in "@invoker/core" "@invoker/persistence" "@invoker/app"; do
    echo "==> pnpm --filter $filter build"
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      status=$?
      echo "FAIL: build failed for $filter (exit $status)" >&2
      cat "$log" >&2
      return "$status"
    fi
  done
  if grep -E "Conditions for '[^']+' are never used" "$log" >/dev/null 2>&1; then
    echo "FAIL: unreachable 'types' condition warnings detected in build output:" >&2
    grep -nE "Conditions for '[^']+' are never used" "$log" >&2 || true
    return 1
  fi
  if grep -E "No projects matched the filters" "$log" >/dev/null 2>&1; then
    echo "FAIL: pnpm reported 'No projects matched the filters' during build:" >&2
    grep -nE "No projects matched the filters" "$log" >&2 || true
    return 1
  fi
  echo "PASS: targeted builds emitted no unreachable 'types' condition warnings."
}

case "$MODE" in
  export-order)    check_export_order ;;
  targeted-builds) check_targeted_builds ;;
  run-sh)          check_run_sh ;;
  ""|-h|--help)    usage; exit 2 ;;
  *) echo "Unknown mode: $MODE" >&2; usage; exit 2 ;;
esac
