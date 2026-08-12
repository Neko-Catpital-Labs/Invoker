#!/usr/bin/env bash
# SSH + headless cases, shard 1; exits 0 when localhost sshd is unavailable (skip).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash "$ROOT/scripts/test-e2e-ssh-runtime-env.sh"
exec bash "$ROOT/scripts/e2e-ssh/run-all.sh" 'case-3.[123]-*.sh'
