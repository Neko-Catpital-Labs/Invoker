#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-gate-db-vs-memory-repro.XXXXXX")"
TEST_DIR="$ROOT_DIR/packages/data-store/.tmp/gate-db-vs-memory-repro.$$"
TEST_FILE="$TEST_DIR/gate-db-vs-memory-repro.test.ts"
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

describe('downstream gate blind to a DB-completed but unhydrated upstream', () => {
  it('clears the completed external gate from the DB when the upstream is not in memory', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-gate-db-vs-memory-'));
    process.env.INVOKER_DB_DIR = dbDir;
    const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    adapters.push(adapter);

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 10,
    });

    orchestrator.loadPlan({
      name: 'upstream',
      mergeMode: 'automatic',
      tasks: [{ id: 'upstream-leaf', description: 'upstream leaf' }],
    });
    const upstreamWfId = orchestrator.getWorkflowIds()[0]!;
    const upstreamLeafId = `${upstreamWfId}/upstream-leaf`;
    const upstreamMergeId = `__merge__${upstreamWfId}`;

    orchestrator.loadPlan({
      name: 'downstream',
      externalDependencies: [
        {
          workflowId: upstreamWfId,
          taskId: '__merge__',
          requiredStatus: 'completed',
          gatePolicy: 'completed',
        },
      ],
      tasks: [{ id: 'downstream-leaf', description: 'downstream should start once the upstream merges' }],
    });
    const downstreamWfId = orchestrator.getWorkflowIds()[1]!;
    const downstreamLeafId = `${downstreamWfId}/downstream-leaf`;

    // The upstream has fully merged in the durable store; the downstream is
    // still pending.
    adapter.updateTask(upstreamLeafId, { status: 'completed', execution: { completedAt: new Date() } });
    adapter.updateTask(upstreamMergeId, { status: 'completed', execution: { completedAt: new Date() } });

    // Simulate an owner that re-hydrated ONLY the downstream — the long-merged
    // upstream is absent from the in-memory graph.
    orchestrator.removeAllWorkflows();
    orchestrator.hydrateWorkflowFromDb(downstreamWfId);

    const inMemoryWorkflowIds = orchestrator.getWorkflowIds();
    const readiness = orchestrator.getTaskLaunchReadiness(downstreamLeafId);
    const started = orchestrator.startExecution();

    console.log(JSON.stringify({
      inMemoryWorkflowIds,
      upstreamHydrated: inMemoryWorkflowIds.includes(upstreamWfId),
      upstreamMergeStatusInDb: adapter.loadTasks(upstreamWfId).find((t) => t.config.isMergeNode)?.status,
      readiness: { ready: readiness.ready, reason: readiness.reason ?? null },
      downstreamStatus: orchestrator.getTask(downstreamLeafId)?.status,
      startedIds: started.map((t) => t.id),
    }));

    expect(inMemoryWorkflowIds).not.toContain(upstreamWfId);
    expect(adapter.loadTasks(upstreamWfId).find((t) => t.config.isMergeNode)?.status).toBe('completed');
    expect(readiness.reason ?? '').not.toMatch(/prerequisite|waiting on/i);
    expect(readiness.ready).toBe(true);
    expect(started.map((t) => t.id)).toContain(downstreamLeafId);
    expect(orchestrator.getTask(downstreamLeafId)?.status).toBe('running');
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

echo "PASS: an external 'completed' gate clears from the durable store even when the upstream merge node is not hydrated in memory, so the downstream launches."
