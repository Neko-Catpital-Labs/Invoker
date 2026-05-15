#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-startup-lineage-guards.sh [--expect bug|fixed]

What it proves:
  Product-path SSH startup lineage repro. It uses a real GUI owner and real
  headless recreate-task, with a fake ssh binary that blocks then fails the
  first managed SSH startup after branch/worktree metadata exists.

This is the Step 3 repro for:
  Fix intent cancellation Step 3: SSH startup lineage guards.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  "$@"
}

cd "$ROOT_DIR"

run_with_timeout "$TIMEOUT_SECONDS" \
  bash scripts/repro/repro-ssh-startup-lineage-e2e.sh --expect "$EXPECTATION"
