#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
SKILL_FILE="$REPO_ROOT/skills/invoker-setup/SKILL.md"
CONTRACT_FILE="$REPO_ROOT/packages/contracts/src/prerequisites.ts"
SKILL_TEXT="$(tr '\n' ' ' < "$SKILL_FILE")"

if ! grep -Eq "status: 'error'" "$CONTRACT_FILE"; then
  echo "[repro] FAIL: default-preset contract error status was not found; update this repro with the new contract."
  exit 1
fi

if [[ "$SKILL_TEXT" == *"default preset's tool is missing it warns but still starts"* ]]; then
  echo "[repro] FAIL: invoker-setup docs describe a missing default preset tool as a warning, but the contract reports an error."
  exit 1
fi

if [[ "$SKILL_TEXT" != *"default preset's tool is missing, the readiness check reports an error while startup still continues"* ]]; then
  echo "[repro] FAIL: invoker-setup docs do not explicitly align missing default preset tool status with the contract error."
  exit 1
fi

echo "[repro] PASS: invoker-setup docs describe missing default preset tools as readiness errors while startup continues."
