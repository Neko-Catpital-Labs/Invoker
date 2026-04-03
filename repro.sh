#!/usr/bin/env bash
# Reproduces the "Fix with Codex" SSH invocation for task:
#   wf-1775161799945-2/regression-all-tests
# From invoker.log @ 2026-04-03T00:35:26.035Z
#
# Usage: ./repro.sh

set -euo pipefail

REMOTE_USER="invoker"
REMOTE_HOST="157.230.133.215"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_PORT=22
REMOTE_CWD='~/.invoker/worktrees/049de5b865cc/experiment-wf-1775161799945-2-regression-all-tests-9aea8712'

PROMPT='A build/test command failed. Fix the code so the command succeeds.

Task: Run all package tests to verify the complete refactoring
Command: cd packages/executors && pnpm test 2>&1 && cd ../persistence && pnpm test 2>&1 && cd ../app && pnpm test 2>&1 && cd ../ui && pnpm test 2>&1

Error output (last 200 lines):
(truncated — original was ~200 lines of vitest output with 2 failing conflict-resolver tests)

Fix the underlying code issue. Do NOT modify the command itself.'

# This is the command that runs on the remote side
AGENT_CMD="codex exec --json --full-auto \"\$PROMPT\""

# The actual mechanism: base64-encode the command into a bash script piped over SSH stdin
AGENT_CMD_B64=$(echo -n "codex 'exec' '--json' '--full-auto' '${PROMPT}'" | base64 -w0)

SCRIPT="set -euo pipefail
WT=\"${REMOTE_CWD}\"
if [[ \"\$WT\" == '~' ]]; then WT=\"\$HOME\"; elif [[ \"\${WT:0:2}\" == '~/' ]]; then WT=\"\$HOME/\${WT:2}\"; fi
cd \"\$WT\"
eval \"\$(echo \"${AGENT_CMD_B64}\" | base64 -d)\"
"

echo "=== SSH target: ${REMOTE_USER}@${REMOTE_HOST}:${SSH_PORT} ==="
echo "=== Remote cwd: ${REMOTE_CWD} ==="
echo "=== Agent cmd:  codex exec --json --full-auto <prompt> ==="
echo ""

ssh \
  -i "${SSH_KEY}" \
  -p "${SSH_PORT}" \
  -o StrictHostKeyChecking=accept-new \
  -o BatchMode=yes \
  "${REMOTE_USER}@${REMOTE_HOST}" \
  bash -s <<< "${SCRIPT}"
