#!/usr/bin/env bash
# SSH + headless cases, shard 1; exits 0 when localhost sshd is unavailable (skip).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
export INVOKER_E2E_SSH_SKIP_MANAGED_PNPM_INSTALL="${INVOKER_E2E_SSH_SKIP_MANAGED_PNPM_INSTALL:-1}"
exec bash "$ROOT/scripts/e2e-ssh/run-all.sh" 'case-3.[123]-*.sh'
