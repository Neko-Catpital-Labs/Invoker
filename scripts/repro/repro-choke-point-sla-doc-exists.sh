#!/usr/bin/env bash
# Proof: the choke-point SLA architecture note exists at its committed path.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC_PATH="$ROOT_DIR/docs/architecture/choke-point-slas.md"

test -f "$DOC_PATH"
grep -q '^# Choke-Point SLAs$' "$DOC_PATH"
grep -q '^## Confirmed Budgets$' "$DOC_PATH"
grep -q '^## Completeness Contract$' "$DOC_PATH"
