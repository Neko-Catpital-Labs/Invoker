#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS="${PROD_SCALE_WORKFLOWS:-24}"
DRAIN_MS="${PROD_SCALE_DRAIN_MS:-30000}"
TIMEOUT_SECONDS="${PROD_SCALE_TIMEOUT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage: scripts/bench-workflow-drain-queue.sh [--workflows N] [--drain-ms MS] [--timeout SECONDS]

Runs a synthetic, in-memory workflow mutation drain benchmark. This measures
workflow_mutation_intents queue wait: started_at - created_at.

The benchmark does not create real workflows, launch task processes, or touch
the production Invoker DB. It generates a temporary Vitest file, runs it, and
removes it before exiting.

Examples:
  scripts/bench-workflow-drain-queue.sh --workflows 24 --drain-ms 30000
  scripts/bench-workflow-drain-queue.sh --workflows 3 --drain-ms 10
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflows)
      WORKFLOWS="${2:-}"
      shift 2
      ;;
    --drain-ms)
      DRAIN_MS="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$WORKFLOWS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --workflows value: $WORKFLOWS" >&2
  exit 1
fi
if ! [[ "$DRAIN_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --drain-ms value: $DRAIN_MS" >&2
  exit 1
fi
if ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --timeout value: $TIMEOUT_SECONDS" >&2
  exit 1
fi

BENCH_FILE="$ROOT_DIR/packages/app/src/__tests__/workflow-drain-queue-bench.tmp.test.ts"

cleanup() {
  rm -f "$BENCH_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat > "$BENCH_FILE" <<'TS'
import { describe, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const workflowCount = Number(process.env.PROD_SCALE_WORKFLOWS ?? 24);
const drainMs = Number(process.env.PROD_SCALE_DRAIN_MS ?? 30_000);
const timeoutMs = Number(process.env.PROD_SCALE_TIMEOUT_SECONDS ?? 120) * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
}

describe('temporary workflow drain queue benchmark', () => {
  it('prints workflow mutation queue wait metrics', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-workflow-drain-queue-bench',
      async () => {
        await sleep(drainMs);
      },
    );

    const startedAt = Date.now();
    const promises: Promise<void>[] = [];
    for (let index = 1; index <= workflowCount; index += 1) {
      const workflowId = `wf-bench-${index}`;
      adapter.saveWorkflow({
        id: workflowId,
        name: workflowId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      promises.push(coordinator.enqueue<void>(workflowId, 'normal', 'bench', [workflowId]));
    }

    await Promise.all(promises);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const rows = (adapter as unknown as {
      queryAll: (sql: string) => Array<{ queue_wait_seconds: number }>;
    }).queryAll(`
      select (julianday(started_at) - julianday(created_at)) * 86400.0 as queue_wait_seconds
      from workflow_mutation_intents
      where status = 'completed'
      order by id asc
    `);
    const waits = rows.map((row) => row.queue_wait_seconds).sort((left, right) => left - right);
    process.stdout.write(
      [
        'WORKFLOW_DRAIN_QUEUE_BENCH',
        `workflows=${workflowCount}`,
        'cap=none',
        `drainMs=${drainMs}`,
        `elapsedSeconds=${elapsedSeconds.toFixed(3)}`,
        `p50QueueWaitSeconds=${percentile(waits, 0.5).toFixed(3)}`,
        `p90QueueWaitSeconds=${percentile(waits, 0.9).toFixed(3)}`,
        `p99QueueWaitSeconds=${percentile(waits, 0.99).toFixed(3)}`,
        `maxQueueWaitSeconds=${(waits.at(-1) ?? 0).toFixed(3)}`,
      ].join(' ') + '\n',
    );
    adapter.close();
  }, timeoutMs);
});
TS

(
  cd "$ROOT_DIR"
  PROD_SCALE_WORKFLOWS="$WORKFLOWS" \
  PROD_SCALE_DRAIN_MS="$DRAIN_MS" \
  PROD_SCALE_TIMEOUT_SECONDS="$TIMEOUT_SECONDS" \
    pnpm --filter @invoker/app exec vitest run src/__tests__/workflow-drain-queue-bench.tmp.test.ts --reporter=verbose
)
