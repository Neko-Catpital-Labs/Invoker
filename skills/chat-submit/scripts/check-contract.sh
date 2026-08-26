#!/usr/bin/env bash
# Contract checks for skills/chat-submit/SKILL.md.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$SKILL_DIR/SKILL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$SKILL" ]] || fail "missing $SKILL"

must_contain() {
  local needle="$1"
  local hint="$2"
  if ! grep -qF -- "$needle" "$SKILL"; then
    fail "$hint — missing: $needle"
  fi
}

must_contain 'invoker_prepare_plan_review' 'chat-submit must prepare a review'
must_contain 'reviewToken' 'chat-submit must require a review token'
must_contain 'One approval before submit by default' 'chat-submit must keep the default approval gate'
must_contain 'invoker_submit_plan' 'chat-submit must submit via MCP'
must_contain 'mode: "live"' 'chat-submit must submit live'
must_contain 'invoker_wait_for_workflow' 'chat-submit must wait on workflow status'
must_contain '## Local vs remote owner' 'chat-submit must document local vs remote owner'
must_contain 'invoker-cli mcp' 'chat-submit must default to local invoker-cli mcp'
must_contain 'references/local-vs-remote-mcp.md' 'chat-submit must point at the remote MCP reference'
must_contain 'Never invent HTTP/SSE MCP' 'chat-submit must forbid inventing HTTP/SSE MCP'

echo "OK: chat-submit skill contract"
