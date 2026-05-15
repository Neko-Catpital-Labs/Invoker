#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/repro/start-running-mece-mock/lib.sh"
run_start_running_mece_issue_repro "remote-git-bootstrap-lock"
