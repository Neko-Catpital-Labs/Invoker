#!/usr/bin/env bash
# Verify that workspace builds and the launcher script do not surface the
# known classes of build-noise we have just normalized:
#
#   * export-order   — every workspace package.json with an "exports" object
#                      places the "types" condition before "import"/"require".
#                      Tsup/esbuild warns ("the condition 'types' here will
#                      never be used as it comes after both 'import' and
#                      'require'") when the order is reversed; this mode
#                      asserts none remain by inspecting metadata directly.
#   * targeted-builds — runs the targeted pnpm builds we expect to be silent
#                      after the export-order fix and fails if any tsup
#                      output contains the unreachable-condition warning.
#   * run-sh         — runs `./run.sh --headless --help` (no GUI launch) and
#                      fails if pnpm prints "No projects matched the filters"
#                      (the launcher referencing a non-existent workspace
#                      package).
#
# Each mode exits 0 when the relevant warning markers are absent and exits
# nonzero (with the offending output) when they are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

usage() {
  cat >&2 <<USAGE
Usage: $(basename "$0") <mode>

Modes:
  export-order      Assert every packages/*/package.json with an "exports"
                    object orders "types" before "import"/"require".
  targeted-builds   Build @invoker/core, @invoker/persistence, @invoker/app
                    and fail on tsup/esbuild "types" condition warnings.
  run-sh            Run ./run.sh --headless --help and fail on pnpm
                    "No projects matched the filters" warnings.
USAGE
}

run_export_order() {
  node --input-type=module -e '
    import { readdirSync, readFileSync, statSync } from "node:fs";
    import { join } from "node:path";

    const packagesDir = "packages";
    const offenders = [];

    for (const entry of readdirSync(packagesDir)) {
      const pkgPath = join(packagesDir, entry, "package.json");
      let raw;
      try {
        raw = readFileSync(pkgPath, "utf8");
      } catch {
        continue;
      }
      let pkg;
      try {
        pkg = JSON.parse(raw);
      } catch (err) {
        console.error(`FAIL: cannot parse ${pkgPath}: ${err.message}`);
        process.exit(2);
      }
      const exportsField = pkg.exports;
      if (!exportsField || typeof exportsField !== "object") continue;

      const walk = (node, trail) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const keys = Object.keys(node);
        const hasConditions = keys.some((k) => ["types", "import", "require", "default", "node", "browser"].includes(k));
        if (hasConditions && keys.includes("types")) {
          const typesIdx = keys.indexOf("types");
          for (const cond of ["import", "require"]) {
            const condIdx = keys.indexOf(cond);
            if (condIdx !== -1 && condIdx < typesIdx) {
              offenders.push(`${pkgPath} :: ${trail.join(" > ") || "."} :: "types" after "${cond}"`);
            }
          }
        }
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            walk(v, [...trail, k]);
          }
        }
      };
      walk(exportsField, []);
    }

    if (offenders.length > 0) {
      console.error("FAIL: workspace exports with \"types\" after \"import\"/\"require\":");
      for (const line of offenders) console.error(`  - ${line}`);
      process.exit(1);
    }
    console.log("PASS: all workspace exports order \"types\" before \"import\"/\"require\".");
  '
}

run_targeted_builds() {
  local log
  log="$(mktemp -t verify-build-warning-clean.XXXXXX.log)"
  trap 'rm -f "$log"' RETURN

  local failed=0
  for filter in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> pnpm --filter $filter build" >&2
    if ! pnpm --filter "$filter" build >>"$log" 2>&1; then
      echo "FAIL: build for $filter exited nonzero" >&2
      failed=1
    fi
  done

  # Match the esbuild/tsup wording for an unreachable "types" export condition.
  # Examples observed across tsup 8.x:
  #   ▲ [WARNING] The condition "types" here will never be used as it comes after both "import" and "require"
  #   ▲ [WARNING] The "types" condition here will never be used as it comes after both "import" and "require"
  if grep -E -i '("types"|condition "types").*(never be used|will never)' "$log" >/dev/null; then
    echo "FAIL: targeted builds emitted unreachable-types warning(s):" >&2
    grep -E -i '("types"|condition "types").*(never be used|will never)' "$log" >&2 || true
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    return 1
  fi
  echo "PASS: targeted builds completed without unreachable-types warnings."
}

run_run_sh() {
  local log
  log="$(mktemp -t verify-build-warning-clean.XXXXXX.log)"
  trap 'rm -f "$log"' RETURN

  # Use a sandbox INVOKER_DB_DIR + headless --help so the launcher exercises
  # the build path without invoking a real plan or touching the user's DB.
  local tmpdb
  tmpdb="$(mktemp -d)"
  INVOKER_DB_DIR="$tmpdb" ./run.sh --headless --help >"$log" 2>&1 || true
  rm -rf "$tmpdb"

  if grep -F 'No projects matched the filters' "$log" >/dev/null; then
    echo "FAIL: ./run.sh emitted \"No projects matched the filters\":" >&2
    grep -F 'No projects matched the filters' "$log" >&2 || true
    return 1
  fi
  echo "PASS: ./run.sh did not emit \"No projects matched the filters\"."
}

case "$MODE" in
  export-order)    run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh)          run_run_sh ;;
  ""|-h|--help)
    usage
    exit 1
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage
    exit 1
    ;;
esac
