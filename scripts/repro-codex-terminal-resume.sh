#!/usr/bin/env bash
# Repro: verify "Fix with Codex" terminal resume dispatches codex, not claude.
#
# Tests against a COPY of the real DB to avoid mutation.
# Simulates bug #1 fix (agentName persisted) then checks getRestoredTerminalSpec.
set -euo pipefail

TASK_ID="wf-1775070568717-10/run-core-tests"
DB_SRC="$HOME/.invoker/invoker.db"
DB_COPY="/tmp/repro-codex-resume-test.db"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "=== Repro: codex terminal resume for $TASK_ID ==="
echo ""

# 1. Check DB exists
if [ ! -f "$DB_SRC" ]; then
  echo "ERROR: DB not found at $DB_SRC"
  exit 1
fi

# 2. Work on a copy
cp "$DB_SRC" "$DB_COPY"

echo "--- Step 1: Current DB state (BEFORE fix) ---"
echo ""
sqlite3 "$DB_COPY" <<SQL
.headers on
.mode column
SELECT
  execution_agent AS config_agent,
  agent_name AS runtime_agent,
  agent_session_id AS session_id,
  familiar_type
FROM tasks
WHERE id = '$TASK_ID';
SQL

EFFECTIVE=$(sqlite3 "$DB_COPY" "SELECT COALESCE(agent_name, execution_agent) FROM tasks WHERE id = '$TASK_ID';")
echo ""
echo "getExecutionAgent() would return: '${EFFECTIVE:-NULL}'"

if [ -z "$EFFECTIVE" ]; then
  echo ""
  echo "BUG CONFIRMED: agent_name is NULL because it was never persisted."
  echo "The fix adds 'agentName' to execMap so updateTask writes to agent_name column."
fi

# 3. Simulate the fix: write agent_name = 'codex' (what updateTask now does)
echo ""
echo "--- Step 2: Simulating fix (SET agent_name = 'codex') ---"
echo ""
sqlite3 "$DB_COPY" "UPDATE tasks SET agent_name = 'codex' WHERE id = '$TASK_ID';"

EFFECTIVE_AFTER=$(sqlite3 "$DB_COPY" "SELECT COALESCE(agent_name, execution_agent) FROM tasks WHERE id = '$TASK_ID';")
echo "getExecutionAgent() now returns: '$EFFECTIVE_AFTER'"

# 4. Verify the resume command via the built executor code
echo ""
echo "--- Step 3: Verify getRestoredTerminalSpec produces codex resume ---"
echo ""

cd "$REPO_ROOT"

node -e "
const { registerBuiltinAgents, SshFamiliar, WorktreeFamiliar } = require('./packages/executors/dist/index.js');

const agentRegistry = registerBuiltinAgents();
const meta = {
  taskId: '$TASK_ID',
  familiarType: 'ssh',
  agentSessionId: 'eaf58ca4-d108-4c0b-8f02-87a9d0c87ca0',
  workspacePath: '/tmp',
  branch: 'experiment/wf-1775070568717-10/run-core-tests-b8277598',
  executionAgent: 'codex',
};

// Test 1: SSH familiar WITH fix (agentRegistry + executionAgent='codex')
console.log('Test 1: SSH familiar WITH fix (agentRegistry + executionAgent=codex)');
const ssh = new SshFamiliar({
  host: 'example.com', user: 'root', sshKeyPath: '/tmp/key',
  agentRegistry,
});
const spec = ssh.getRestoredTerminalSpec(meta);
const innerCmd = spec.args[spec.args.length - 1];
console.log('  inner shell cmd:', innerCmd);

const hasCodex = innerCmd.includes('codex') && innerCmd.includes('exec') && innerCmd.includes('resume');
const hasClaude = innerCmd.includes('claude --resume');

if (hasCodex && !hasClaude) {
  console.log('  PASS: Resume uses CODEX (codex exec resume <id>)');
} else {
  console.log('  FAIL: Resume uses CLAUDE instead of codex');
  process.exit(1);
}

// Test 2: SSH familiar WITHOUT fix (no agentRegistry, no executionAgent)
console.log('');
console.log('Test 2: SSH familiar WITHOUT fix (no agentRegistry, no executionAgent)');
const brokenSsh = new SshFamiliar({
  host: 'example.com', user: 'root', sshKeyPath: '/tmp/key',
});
const brokenMeta = { ...meta, executionAgent: undefined };
const brokenSpec = brokenSsh.getRestoredTerminalSpec(brokenMeta);
const brokenInner = brokenSpec.args[brokenSpec.args.length - 1];
console.log('  inner shell cmd:', brokenInner);
if (brokenInner.includes('claude --resume')) {
  console.log('  CONFIRMED BUG: Without fix, falls back to claude --resume');
} else {
  console.log('  Unexpected: not claude either?');
}

// Test 3: Worktree familiar WITH fix
console.log('');
console.log('Test 3: Worktree familiar WITH fix (agentRegistry + executionAgent=codex)');
const wt = new WorktreeFamiliar({
  worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache',
  agentRegistry,
});
const wtSpec = wt.getRestoredTerminalSpec({ ...meta, familiarType: 'worktree' });
console.log('  command:', wtSpec.command);
console.log('  args:', JSON.stringify(wtSpec.args));
if (wtSpec.command === 'codex') {
  console.log('  PASS: Resume uses CODEX');
} else {
  console.log('  FAIL: Resume uses', wtSpec.command, 'instead of codex');
  process.exit(1);
}

// Test 4: Worktree familiar WITHOUT fix
console.log('');
console.log('Test 4: Worktree familiar WITHOUT fix (no agentRegistry, no executionAgent)');
const brokenWt = new WorktreeFamiliar({
  worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache',
});
const brokenWtSpec = brokenWt.getRestoredTerminalSpec({ ...brokenMeta, familiarType: 'worktree' });
console.log('  command:', brokenWtSpec.command);
if (brokenWtSpec.command === 'claude') {
  console.log('  CONFIRMED BUG: Without fix, falls back to claude');
} else {
  console.log('  Unexpected:', brokenWtSpec.command);
}
" 2>&1

EXIT=$?

# Cleanup
rm -f "$DB_COPY"

echo ""
if [ $EXIT -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
else
  echo "=== CHECKS FAILED ==="
fi
exit $EXIT
