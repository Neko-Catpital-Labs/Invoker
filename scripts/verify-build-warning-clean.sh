#!/usr/bin/env bash
# Verify that the workspace builds are free of the two noisy warning markers
# that show up in the ./run.sh build log:
#
#   1. tsup/esbuild "The condition \"types\" here will never be used"
#      — caused by export objects that list "types" after "import"/"require".
#   2. pnpm "No projects matched the filters"
#      — caused by launcher/helper scripts referencing a workspace package
#      filter that no longer resolves (e.g. the removed @invoker/executors).
#
# Modes (exit 0 on pass, nonzero when the warning marker is present):
#   export-order    — static check of every packages/*/package.json export
#                     object: fails if "types" comes after "import" or
#                     "require" inside any condition map.
#   targeted-builds — runs the targeted pnpm builds (core, persistence, app)
#                     and fails if the captured build log contains the
#                     unreachable "types" condition warning.
#   run-sh          — static check of every `pnpm --filter @invoker/...`
#                     reference in run.sh and scripts/verify-executor-routing.sh;
#                     fails if any named filter does not resolve to a workspace
#                     package (which would emit "No projects matched the filters").
set -euo pipefail

MODE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/verify-build-warning-clean.sh {export-order|targeted-builds|run-sh}

Modes:
  export-order     Static check: every packages/*/package.json export object
                   must list "types" before "import"/"require".
  targeted-builds  Run targeted pnpm builds (core, persistence, app) and fail
                   if the build log contains the unreachable types-condition
                   warning.
  run-sh           Static check: every `pnpm --filter @invoker/...` reference
                   in run.sh and scripts/verify-executor-routing.sh must
                   resolve to a workspace package.
EOF
  exit 64
}

run_export_order() {
  python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
issues = []
for pkg_json in sorted(root.glob("packages/*/package.json")):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        issues.append(f"{pkg_json}: invalid JSON ({exc})")
        continue
    exports = data.get("exports")
    if not isinstance(exports, dict):
        continue
    for entry_key, entry_val in exports.items():
        if not isinstance(entry_val, dict):
            continue
        conditions = list(entry_val.keys())
        if "types" not in conditions:
            continue
        types_idx = conditions.index("types")
        for blocker in ("import", "require"):
            if blocker in conditions and conditions.index(blocker) < types_idx:
                issues.append(
                    f"{pkg_json.relative_to(root)}: exports[{entry_key!r}] has "
                    f"'types' after '{blocker}' (conditions: {conditions})"
                )

if issues:
    print("WARN-MARKER: unreachable \"types\" export condition", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue}", file=sys.stderr)
    sys.exit(1)

print("export-order: OK — every export object lists \"types\" before \"import\"/\"require\"")
PY
}

run_targeted_builds() {
  local log
  log="$(mktemp)"

  local status=0
  local pkg
  for pkg in @invoker/core @invoker/persistence @invoker/app; do
    echo "==> pnpm --filter $pkg build" >&2
    if ! pnpm --filter "$pkg" build >>"$log" 2>&1; then
      echo "FAIL: '$pkg' build returned nonzero" >&2
      status=1
    fi
  done

  # The exact tsup/esbuild wording is:
  #   "The condition \"types\" here will never be used as it comes after both \"import\" and \"require\""
  # Match defensively on the stable substrings so a future esbuild rewording still trips this check.
  if grep -E 'condition "types"|"types" here will never be used|unreachable.*types' "$log" >&2; then
    echo "WARN-MARKER: unreachable \"types\" condition emitted by targeted build" >&2
    status=1
  fi

  rm -f "$log"

  if [[ $status -eq 0 ]]; then
    echo "targeted-builds: OK — no unreachable types-condition warnings in core/persistence/app"
  fi
  return $status
}

run_run_sh() {
  local files=("$ROOT/run.sh" "$ROOT/scripts/verify-executor-routing.sh")
  local f
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL: expected launcher/helper script not found: $f" >&2
      return 1
    fi
  done

  python3 - "$ROOT" "${files[@]}" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
script_paths = [pathlib.Path(p) for p in sys.argv[2:]]

known = set()
for pkg_json in root.glob("packages/*/package.json"):
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        continue
    name = data.get("name")
    if isinstance(name, str) and name:
        known.add(name)

pattern = re.compile(r"pnpm\s+--filter\s+(@invoker/[A-Za-z0-9_-]+)")
issues = []
for script in script_paths:
    text = script.read_text(encoding="utf-8")
    for line_no, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        for match in pattern.finditer(line):
            target = match.group(1)
            if target not in known:
                issues.append(
                    f"{script.relative_to(root)}:{line_no}: pnpm filter '{target}' "
                    f"does not resolve to a workspace package"
                )

if issues:
    print("WARN-MARKER: stale pnpm --filter target (would emit 'No projects matched the filters')", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue}", file=sys.stderr)
    sys.exit(1)

print("run-sh: OK — every launcher/helper pnpm --filter target resolves to a workspace package")
PY
}

case "$MODE" in
  export-order)    run_export_order ;;
  targeted-builds) run_targeted_builds ;;
  run-sh)          run_run_sh ;;
  ""|-h|--help)    usage ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage
    ;;
esac
