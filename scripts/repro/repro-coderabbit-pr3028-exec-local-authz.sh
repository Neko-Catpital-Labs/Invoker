#!/usr/bin/env bash
# Repro: CodeRabbit PR #3028 (Security, Critical) — raw `exec local:` shell must be
# gated behind adminUserIds. Before the fix, any Slack user who can mention the bot
# reaches `runLocalCommand()` -> `/bin/bash -lc <text>` with the full inherited
# environment (host RCE + secret exfiltration via echoed stdout/stderr).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: non-admin (and no-admin) users could run raw local shell via 'exec local:'"
if pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-surface-workflows.test.ts \
  -t "refuses" --reporter=verbose; then
  echo "[repro] PASS: raw 'exec local:' is refused for non-admins and when no admins are configured"
  exit 0
fi

echo "[repro] FAIL: raw 'exec local:' still spawns /bin/bash for unauthorized users"
exit 1
