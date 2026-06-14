#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
KEEP_ARTIFACTS=0
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-workflow-mutation-coordinator-cancellation.sh --expect bug|fixed [--keep-artifacts]

What it proves:
  A high-priority recreate-task fence must abort an older running
  fix-with-agent workflow mutation before taking authority. In the buggy
  behavior, the running fix is not cancelled, so it can perform a late write
  before recreate-task runs.

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  repro setup or assertion was invalid / unexpected
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "repro: missing required command: $1" >&2
    exit 2
  }
}

require_cmd pnpm
require_cmd timeout

cd "$ROOT_DIR"

TEST_BASENAME="workflow-mutation-coordinator-cancellation.$$.repro.test.ts"
TEST_FILE="packages/app/src/__tests__/$TEST_BASENAME"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-workflow-mutation-cancellation.XXXXXX")"

cleanup() {
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -f "$TEST_FILE" "$LOG_FILE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cat >"$TEST_FILE" <<'EOF'
import { describe, expect, it } from 'vitest';
import { WorkflowMutationCoordinator } from '../workflow-mutation-coordinator.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('workflow mutation coordinator cancellation repro', () => {
  it('classifies recreate-task preemption of running fix-with-agent as bug or fixed', async () => {
    const expected = process.env.INVOKER_REPRO_EXPECT;
    if (expected !== 'bug' && expected !== 'fixed') {
      throw new Error('INVOKER_REPRO_EXPECT must be bug or fixed');
    }

    const coordinator = new WorkflowMutationCoordinator();
    const workflowId = 'wf-repro-cancel';
    const fixStarted = deferred();
    const allowFixToReturn = deferred();
    let fixReleased = false;
    let fixObservedAbort = false;
    let staleWrite = false;
    let recreateRan = false;
    let recreateBeforeFixReleased = false;
    const order: string[] = [];

    const runningFix = coordinator.enqueue(
      workflowId,
      'normal',
      async (context?: { signal?: AbortSignal }) => {
        order.push('fix-started');
        fixStarted.resolve();
        await allowFixToReturn.promise;
        if (context?.signal?.aborted) {
          fixObservedAbort = true;
          order.push('fix-aborted');
          return;
        }
        staleWrite = true;
        order.push('fix-late-write');
      },
      {
        channel: 'invoker:fix-with-agent',
        args: [`${workflowId}/task-a`, 'codex'],
      } as never,
    );
    void runningFix.catch(() => {});

    await fixStarted.promise;

    const recreate = coordinator.enqueue(
      workflowId,
      'high',
      async () => {
        recreateRan = true;
        recreateBeforeFixReleased = !fixReleased;
        order.push('recreate-task');
      },
      {
        channel: 'invoker:recreate-task',
        args: [`${workflowId}/task-a`],
      } as never,
    );

    for (let i = 0; i < 20 && !recreateRan; i += 1) {
      await sleep(5);
    }

    fixReleased = true;
    allowFixToReturn.resolve();
    await Promise.allSettled([runningFix, recreate]);

    const observed = recreateBeforeFixReleased && fixObservedAbort && !staleWrite ? 'fixed' : 'bug';
    process.stderr.write(`observed=${observed}\n`);
    process.stderr.write(`order=${order.join(' -> ')}\n`);
    process.stderr.write(`recreateBeforeFixReleased=${String(recreateBeforeFixReleased)}\n`);
    process.stderr.write(`fixObservedAbort=${String(fixObservedAbort)}\n`);
    process.stderr.write(`staleWrite=${String(staleWrite)}\n`);

    expect(observed).toBe(expected);
  });
});
EOF

set +e
INVOKER_REPRO_EXPECT="$EXPECTATION" timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/app exec vitest run \
    --reporter verbose \
    "src/__tests__/$TEST_BASENAME" \
  >"$LOG_FILE" 2>&1
STATUS=$?
set -e

echo "workflow_mutation_cancellation_exit     : $STATUS"
echo "workflow_mutation_cancellation_expected : $EXPECTATION"
echo "workflow_mutation_cancellation_log      : $LOG_FILE"

if [[ "$STATUS" -ne 0 ]]; then
  echo "==> repro mismatch"
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

echo "==> repro matched expectation"
