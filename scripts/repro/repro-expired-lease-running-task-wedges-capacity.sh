#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-expired-lease-capacity-repro.XXXXXX")"
TEST_DIR="$ROOT_DIR/packages/data-store/.tmp/expired-lease-capacity-repro.$$"
TEST_FILE="$TEST_DIR/expired-lease-capacity-repro.test.ts"
DB_DIR="$TMP_ROOT/db"

cleanup() {
  local ec=$?
  rm -rf "$TEST_DIR"
  rm -rf "$TMP_ROOT"
  return "$ec"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$TEST_DIR"

cat > "$TEST_FILE" <<'TS'
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
}

const adapters: SQLiteAdapter[] = [];

afterEach(() => {
  while (adapters.length > 0) {
    adapters.pop()?.close();
  }
});

describe('a running task with an expired lease wedges concurrency capacity', () => {
  it('frees the slot once the executor lease has lapsed so a ready task can launch', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-expired-lease-capacity-'));
    process.env.INVOKER_DB_DIR = dbDir;
    const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    adapters.push(adapter);

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 1,
    });

    // Workflow A takes the single slot and starts running.
    orchestrator.loadPlan({
      name: 'zombie',
      tasks: [{ id: 'stuck', description: 'runs then strands' }],
    });
    const zombieWfId = orchestrator.getWorkflowIds()[0]!;
    const zombieId = `${zombieWfId}/stuck`;
    orchestrator.startExecution();
    expect(orchestrator.getTask(zombieId)?.status).toBe('running');

    // Its executor dies with no completion: the attempt lease lapses in the past.
    const attemptId = orchestrator.getTask(zombieId)!.execution.selectedAttemptId!;
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    adapter.updateAttempt(attemptId, { leaseExpiresAt: longAgo, lastHeartbeatAt: longAgo });

    // Workflow B is ready and only needs the one slot the zombie is squatting.
    orchestrator.loadPlan({
      name: 'blocked',
      tasks: [{ id: 'wants-slot', description: 'ready, waiting for capacity' }],
    });
    const waitingWfId = orchestrator.getWorkflowIds()[1]!;
    const waitingId = `${waitingWfId}/wants-slot`;

    const started = orchestrator.startExecution();

    console.log(JSON.stringify({
      zombieStatus: orchestrator.getTask(zombieId)?.status,
      zombieLeaseExpiresAt: adapter.loadAttempt(attemptId)?.leaseExpiresAt?.toISOString(),
      waitingStatus: orchestrator.getTask(waitingId)?.status,
      startedIds: started.map((t) => t.id),
    }));

    expect(orchestrator.getTask(zombieId)?.status).toBe('running');
    expect(started.map((t) => t.id)).toContain(waitingId);
    expect(orchestrator.getTask(waitingId)?.status).toBe('running');
  });
});
TS

echo "temporary_root=$TMP_ROOT"
echo "temporary_db_dir=$DB_DIR"
echo "repro_test=$TEST_FILE"
echo "command=INVOKER_DB_DIR=$DB_DIR pnpm --filter @invoker/data-store exec vitest run $TEST_FILE --reporter=dot"

(
  cd "$ROOT_DIR"
  INVOKER_DB_DIR="$DB_DIR" pnpm --filter @invoker/data-store exec vitest run "$TEST_FILE" --reporter=dot
)

echo "PASS: a running task whose executor lease has expired no longer counts against maxConcurrency, so a genuinely ready pending task launches into the freed slot."
