#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
SKILL_FILE="$REPO_ROOT/skills/invoker-setup/SKILL.md"
CONTRACT_FILE="$REPO_ROOT/packages/contracts/src/prerequisites.ts"

if grep -Eq "id: ['\"]node['\"]" "$CONTRACT_FILE"; then
  echo "[repro] FAIL: readiness contract now includes node; update this repro and docs together."
  exit 1
fi

if grep -Eq 'canonical tool set \(`node`' "$SKILL_FILE"; then
  echo "[repro] FAIL: invoker-setup docs list node in the canonical readiness tool set, but the contract does not."
  exit 1
fi

echo "[repro] PASS: invoker-setup canonical readiness tool docs do not include node."
