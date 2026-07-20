#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-merge-git-timeout.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

fake_bin="$tmpdir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env node
setInterval(() => {}, 1000);
EOF
chmod +x "$fake_bin/git"

echo "[repro] task: __merge__wf-1778431101981-51"
echo "[repro] root cause A: --no-track active-outbox retry threw after durable dispatch enqueue"
echo "[repro] root cause B: merge consolidation git commands were spawned without a timeout"

node --input-type=module <<'NODE'
const runnable = [{
  id: '__merge__wf-1778431101981-51',
  execution: { selectedAttemptId: '__merge__wf-1778431101981-51-aebaca8bd' },
}];
const dispatches = [{
  taskId: '__merge__wf-1778431101981-51',
  attemptId: '__merge__wf-1778431101981-51-aebaca8bd',
  state: 'enqueued',
}];
const ownerTaskRunner = null;
const deferRunnableTasks = undefined;

const preFixWouldThrow = !ownerTaskRunner && !deferRunnableTasks;
const fixedAcceptsDurableDispatch = dispatches.some((row) =>
  runnable.some((task) => task.execution.selectedAttemptId === row.attemptId)
);

if (!preFixWouldThrow || !fixedAcceptsDurableDispatch) {
  console.error('[repro] expected active-outbox no-track fixture to prove durable handoff condition');
  process.exit(1);
}
console.log('[repro] pre-fix simulation: no-track retry would throw despite an enqueued durable dispatch');
console.log('[repro] fixed expectation: durable dispatch is left for the owner dispatcher');
NODE

PATH="$fake_bin:$PATH" node --input-type=module - "$tmpdir" <<'NODE'
import { spawn } from 'node:child_process';

const cwd = process.argv[2];
const child = spawn('git', ['fetch', 'origin', '+refs/heads/main:refs/heads/main'], {
  cwd,
  stdio: ['ignore', 'ignore', 'ignore'],
});

const result = await Promise.race([
  new Promise((resolve) => child.once('close', (code, signal) => resolve({ kind: 'closed', code, signal }))),
  new Promise((resolve) => setTimeout(() => resolve({ kind: 'pending' }), 250)),
]);

if (result.kind !== 'pending') {
  console.error(`[repro] expected pre-fix raw git spawn to remain pending, got ${JSON.stringify(result)}`);
  process.exit(1);
}

child.kill('SIGKILL');
console.log('[repro] pre-fix simulation: raw git spawn stayed pending with no launch progress');
NODE

if ! rg -q "execGitWithTimeout|exceeded git operation timeout" packages/execution-engine/src/task-runner.ts; then
  echo "[repro] fixed TaskRunner git timeout helper is missing" >&2
  exit 1
fi

if ! rg -q "leaving durable launch dispatches for the owner dispatcher" packages/app/src/headless.ts; then
  echo "[repro] fixed active-outbox no-track handoff is missing" >&2
  exit 1
fi

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/headless-delegation.test.ts \
  -t "headless task retry in no-track active outbox mode accepts durable launch handoff without transient launch ownership"

INVOKER_GIT_NETWORK_TIMEOUT_MS=50 \
  pnpm --filter @invoker/execution-engine exec vitest run \
    src/__tests__/task-runner.test.ts \
    -t "rejects instead of leaving merge consolidation pending when git never exits"

echo "[repro] fixed path: TaskRunner.execGitIn rejects instead of leaving merge consolidation running indefinitely"
