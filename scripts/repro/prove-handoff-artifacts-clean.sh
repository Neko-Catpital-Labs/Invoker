#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

output="$(bash scripts/scrub-handoff-artifacts.sh --check)"

if [[ "$output" != "scrub-handoff-artifacts-ok" ]]; then
  printf '%s\n' "prove: unexpected scrub output: $output" >&2
  exit 1
fi

printf '%s\n' 'prove: no ephemeral handoff artifacts remain'
