#!/usr/bin/env bash
# Repro: CodeRabbit PR #3028 (Functional Correctness, Major) — agent mode must not
# offer to generate Invoker YAML. Plan threads are only created via `plan:`, and
# `handleLobbySubmit` rejects `submit` unless conversationMode === 'plan'. The
# agent system prompt previously allowed YAML "unless the user explicitly asks",
# so an agent thread could draft a plan Slack silently refuses on submit — a
# dead end. The agent prompt must refuse YAML and redirect the user to `plan:`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: agent-mode system prompt let the agent draft un-submittable Invoker YAML"
if pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/plan-conversation.test.ts \
  -t "refuses Invoker YAML" --reporter=verbose; then
  echo "[repro] PASS: agent mode refuses Invoker YAML and redirects to plan:"
  exit 0
fi

echo "[repro] FAIL: agent mode still offers to generate Invoker YAML (un-submittable dead end)"
exit 1
