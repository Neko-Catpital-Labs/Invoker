#!/usr/bin/env bash
#
# Deprecated compatibility wrapper for the retired fork-sync flow.
#
# This script intentionally performs no git mutations.
# It remains for callers that may still invoke it directly.
#
# Usage:
#   bash scripts/sync-fork-upstream.sh <plan.yaml>
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <plan.yaml>" >&2
  exit 2
fi

PLAN_FILE="$1"
if [[ ! -f "$PLAN_FILE" ]]; then
  echo "sync-fork-upstream: plan file not found: $PLAN_FILE" >&2
  exit 1
fi

echo "sync-fork-upstream: deprecated; no action taken."
