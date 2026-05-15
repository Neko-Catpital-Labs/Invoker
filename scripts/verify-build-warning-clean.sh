#!/usr/bin/env bash
# Verify that the workspace build is free of two known noise sources:
#   - esbuild/tsup "types condition will never be used" warnings caused by
#     `types` appearing after `import`/`require` in a package export map.
#   - pnpm "No projects matched the filters" warnings caused by stale package
#     filters in launcher scripts.
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh export-order
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#   bash scripts/verify-build-warning-clean.sh run-sh
#
# Every mode exits 0 on success and nonzero when the relevant warning marker
# is detected.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"

# esbuild prints this exact phrase when the `types` condition is shadowed.
WARN_TYPES_RE='The condition "types" here will never be used'
# pnpm prints this when a --filter expression matches nothing.
WARN_NO_PROJECTS_RE='No projects matched the filters'

usage() {
  echo "Usage: $0 {export-order|targeted-builds|run-sh}" >&2
  exit 64
}

verify_export_order() {
  # Walk every workspace package.json `exports` object and fail if any
  # condition object lists `types` after `import` or `require`.
  python3 - <<'PY'
import json
import pathlib
import sys

root = pathlib.Path('.').resolve()
violations = []

def walk(node, package, path):
    if isinstance(node, dict):
        keys = list(node.keys())
        if "types" in keys:
            ti = keys.index("types")
            offenders = []
            for cond in ("import", "require"):
                if cond in keys and keys.index(cond) < ti:
                    offenders.append(cond)
            if offenders:
                violations.append((package, path, offenders, keys))
        for k, v in node.items():
            walk(v, package, f"{path}/{k}")

for pkg_json in sorted(root.glob('packages/*/package.json')):
    with pkg_json.open() as fp:
        data = json.load(fp)
    exports = data.get('exports')
    if not exports:
        continue
    walk(exports, pkg_json.relative_to(root), 'exports')

if violations:
    print('FAIL: package export maps have "types" after "import"/"require":')
    for package, path, offenders, keys in violations:
        print(f"  {package}: at {path} types appears after {offenders} (order={keys})")
    sys.exit(1)

print('PASS: all workspace export maps list "types" before "import"/"require".')
PY
}

verify_targeted_builds() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  local packages=(
    "@invoker/core"
    "@invoker/persistence"
    "@invoker/app"
  )

  local failed=0
  for pkg in "${packages[@]}"; do
    echo "==> pnpm --filter $pkg build"
    if ! pnpm --filter "$pkg" build >>"$log" 2>&1; then
      echo "FAIL: build failed for $pkg" >&2
      failed=1
    fi
  done

  if grep -q -- "$WARN_TYPES_RE" "$log"; then
    echo 'FAIL: unreachable "types" condition warning detected in targeted builds:' >&2
    grep -n -- "$WARN_TYPES_RE" "$log" >&2 || true
    return 1
  fi

  if grep -q -- "$WARN_NO_PROJECTS_RE" "$log"; then
    echo 'FAIL: "No projects matched the filters" warning detected in targeted builds:' >&2
    grep -n -- "$WARN_NO_PROJECTS_RE" "$log" >&2 || true
    return 1
  fi

  if [ "$failed" -ne 0 ]; then
    return 1
  fi

  echo 'PASS: targeted builds produced no unreachable-types or stale-filter warnings.'
}

verify_run_sh() {
  # Static check: every active `pnpm --filter <pkg> build` in run.sh and the
  # paired verify script must refer to a package that exists in the workspace,
  # otherwise pnpm emits "No projects matched the filters" on every launch.
  local scripts=("run.sh" "scripts/verify-executor-routing.sh")
  local failed=0

  python3 - "${scripts[@]}" <<'PY'
import json
import pathlib
import re
import sys

scripts = sys.argv[1:]
root = pathlib.Path('.').resolve()

names = set()
for pkg_json in root.glob('packages/*/package.json'):
    with pkg_json.open() as fp:
        names.add(json.load(fp).get('name'))

pattern = re.compile(r'pnpm[^\n]*--filter\s+(@?[A-Za-z0-9_./-]+)')
errors = []
for script in scripts:
    path = root / script
    if not path.exists():
        continue
    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        stripped = raw.lstrip()
        if stripped.startswith('#'):
            continue
        for m in pattern.finditer(raw):
            target = m.group(1).strip('"').strip("'")
            if target.startswith('@invoker/') and target not in names:
                errors.append((script, lineno, target, raw.strip()))

if errors:
    print('FAIL: launcher/helper scripts reference stale workspace package filters:')
    for script, lineno, target, line in errors:
        print(f"  {script}:{lineno} filter {target!r} has no matching package -> {line}")
    sys.exit(1)

print('PASS: run.sh and verify-executor-routing.sh only use live workspace package filters.')
PY
}

case "$MODE" in
  export-order) verify_export_order ;;
  targeted-builds) verify_targeted_builds ;;
  run-sh) verify_run_sh ;;
  *) usage ;;
esac
