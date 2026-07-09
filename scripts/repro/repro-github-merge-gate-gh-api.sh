#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] issue: merge-gate PR creation used gh pr list/create paths that are harder to stub and retry"

gh_stub="$ROOT/scripts/e2e-dry-run/fixtures/gh-marker.sh"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-gh-api-repro.XXXXXX")"
trap 'rm -rf "$log_dir"' EXIT

if INVOKER_E2E_MARKER_ROOT="$log_dir" "$gh_stub" pr list >/"$log_dir/pr-list.out" 2>/"$log_dir/pr-list.err"; then
  echo "[repro] expected gh pr list to be rejected by the marker stub"
  exit 1
fi

grep -Fq "gh pr list should not be used" "$log_dir/pr-list.err"
echo "[repro] source check: marker rejects the old gh pr list path"

bash scripts/e2e-dry-run/cases/case-4.2-github-pr.sh

echo "[repro] passed"
