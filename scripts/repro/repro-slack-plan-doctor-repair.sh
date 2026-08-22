#!/usr/bin/env bash
# Repro: first LGTM with an incident-shaped doctor reject must keep repairing
# until skill-doctor passes (and harness append must see a hosted repair prompt).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> surfaces: first-LGTM doctor repair + harness hosted repair prompt"
pnpm --filter @invoker/surfaces exec vitest run src/__tests__/plan-draft-file-activation.test.ts \
  -t 'first LGTM keeps repairing|harness append receives a hosted repair'

echo "[repro] PASS: first-draft doctor repair loop stages a later passing candidate"
