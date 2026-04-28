#!/usr/bin/env bash
set -euo pipefail

# Retry every workflow via the existing workflow-scope retry script.
# This intentionally does not do any rebase/fresh-base work.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec bash "$REPO_ROOT/scripts/retry-failed-and-pending-all-workflows.sh" "$@"
