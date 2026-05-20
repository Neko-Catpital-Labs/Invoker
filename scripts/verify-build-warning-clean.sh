#!/usr/bin/env bash
# Verify that ./run.sh build output is free of known noise:
#   * tsup/esbuild "unreachable" warnings caused by `types` appearing after
#     `import`/`require` in a package export object.
#   * "No projects matched the filters" warnings from launcher/helper scripts
#     still passing the removed `@invoker/executors` package filter.
#
# Modes:
#   export-order     Scan packages/*/package.json; fail if any export object
#                    has `types` after `import` or `require`.
#   targeted-builds  Run the three targeted builds and fail if any of them
#                    print an unreachable-`types` condition warning.
#   run-sh           Fail if active build filters in run.sh or
#                    scripts/verify-executor-routing.sh still reference the
#                    removed `@invoker/executors` package.
#
# Each mode exits 0 on pass and nonzero on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mode="${1:-}"
if [ -z "$mode" ]; then
  echo "Usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 2
fi

case "$mode" in
  export-order)
    node -e '
      const fs = require("fs");
      const path = require("path");
      const root = process.argv[1];
      const pkgsDir = path.join(root, "packages");
      const bad = [];
      for (const entry of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(pkgsDir, entry.name, "package.json");
        if (!fs.existsSync(pkgPath)) continue;
        let json;
        try { json = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
        catch (e) { console.error("Invalid JSON: " + pkgPath); process.exit(1); }
        const exp = json.exports;
        if (!exp || typeof exp !== "object") continue;
        const visit = (subkey, value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return;
          const keys = Object.keys(value);
          const tIdx = keys.indexOf("types");
          const iIdx = keys.indexOf("import");
          const rIdx = keys.indexOf("require");
          if (tIdx !== -1 && ((iIdx !== -1 && tIdx > iIdx) || (rIdx !== -1 && tIdx > rIdx))) {
            bad.push(pkgPath + " @ " + subkey + " :: keys=[" + keys.join(",") + "]");
          }
        };
        for (const [k, v] of Object.entries(exp)) visit(k, v);
      }
      if (bad.length) {
        console.error("FAIL: workspace export objects with `types` after `import`/`require`:");
        for (const line of bad) console.error("  " + line);
        process.exit(1);
      }
      console.log("PASS: all workspace export objects place `types` before `import`/`require`.");
    ' "$ROOT"
    ;;

  targeted-builds)
    targets=(
      "@invoker/core"
      "@invoker/persistence"
      "@invoker/app"
    )
    tmp_out="$(mktemp)"
    trap 'rm -f "$tmp_out"' EXIT
    rc=0
    for t in "${targets[@]}"; do
      echo "==> Building $t"
      if ! ( cd "$ROOT" && pnpm --filter "$t" build ) >"$tmp_out" 2>&1; then
        echo "FAIL: build of $t failed:" >&2
        cat "$tmp_out" >&2
        rc=1
        continue
      fi
      # tsup/esbuild prints something like:
      #   "The condition "types" here will never be used as it comes after both
      #    "import" and "require""
      if grep -E -i 'condition[[:space:]]+"types".*never[[:space:]]+be[[:space:]]+used|"types".*comes[[:space:]]+after[[:space:]]+both|unreachable.*types' "$tmp_out" >/dev/null; then
        echo "FAIL: $t emitted an unreachable `types` condition warning:" >&2
        grep -E -i 'condition[[:space:]]+"types".*never[[:space:]]+be[[:space:]]+used|"types".*comes[[:space:]]+after[[:space:]]+both|unreachable.*types' "$tmp_out" >&2 || true
        rc=1
      fi
    done
    if [ $rc -eq 0 ]; then
      echo "PASS: targeted builds produced no unreachable \`types\` condition warnings."
    fi
    exit "$rc"
    ;;

  run-sh)
    files=(
      "$ROOT/run.sh"
      "$ROOT/scripts/verify-executor-routing.sh"
    )
    rc=0
    for f in "${files[@]}"; do
      if [ ! -f "$f" ]; then continue; fi
      # Match active build filters like:
      #   pnpm --filter @invoker/executors build
      if grep -E -n 'pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors' "$f" >/dev/null; then
        echo "FAIL: $f still references @invoker/executors as a pnpm --filter target:" >&2
        grep -E -n 'pnpm[[:space:]]+--filter[[:space:]]+@invoker/executors' "$f" >&2 || true
        rc=1
      fi
    done
    if [ $rc -eq 0 ]; then
      echo "PASS: no active launcher/helper scripts reference the stale @invoker/executors filter."
    fi
    exit "$rc"
    ;;

  *)
    echo "Unknown mode: $mode" >&2
    echo "Usage: $0 {export-order|targeted-builds|run-sh}" >&2
    exit 2
    ;;
esac
