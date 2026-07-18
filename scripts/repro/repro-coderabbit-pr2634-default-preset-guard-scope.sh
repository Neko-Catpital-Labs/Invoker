#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit-pr2634-guard.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1"
  if [ -n "${2:-}" ]; then
    echo "----- output -----"
    echo "$2"
  fi
  exit 1
}

mkdir -p "$TMP/scripts/repro" "$TMP/skills/invoker-setup" "$TMP/packages/contracts/src"
cp "$REPO_ROOT/scripts/repro/repro-coderabbit-pr2634-default-preset-error.sh" "$TMP/scripts/repro/"
cp "$REPO_ROOT/skills/invoker-setup/SKILL.md" "$TMP/skills/invoker-setup/SKILL.md"

python3 - "$REPO_ROOT/packages/contracts/src/prerequisites.ts" "$TMP/packages/contracts/src/prerequisites.ts" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
needle = """id: 'default-preset',
      name: 'Default planning preset',
      status: 'error',
      detail: `Default preset "${defaultPresetKey}" needs "${preset.tool}", which is not on PATH`"""
replacement = needle.replace("status: 'error'", "status: 'warn'")
if needle not in source:
    raise SystemExit("missing expected default-preset missing-tool branch")
Path(sys.argv[2]).write_text(source.replace(needle, replacement, 1))
PY

set +e
output="$(bash "$TMP/scripts/repro/repro-coderabbit-pr2634-default-preset-error.sh" 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  fail "default-preset repro accepted a contract where the missing-tool branch is warn" "$output"
fi

if [[ "$output" != *"default-preset missing-tool contract error status was not found"* ]]; then
  fail "default-preset repro failed for the wrong reason" "$output"
fi

echo "[repro] PASS: default-preset repro guard is scoped to the missing-tool contract branch."
