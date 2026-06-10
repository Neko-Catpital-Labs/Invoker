#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-review-ready-gate-repro.XXXXXX")"
TEST_DIR="$ROOT_DIR/packages/data-store/.tmp/review-ready-gate-repro.$$"
TEST_FILE="$TEST_DIR/review-ready-gate-repro.test.ts"
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

type ReproCase = {
  adapter: SQLiteAdapter;
  orchestrator: Orchestrator;
  upstreamMergeId: string;
  downstreamTaskId: string;
};

const adapters: SQLiteAdapter[] = [];

async function createReproCase(name: string): Promise<ReproCase> {
  const dbDir = mkdtempSync(join(tmpdir(), `invoker-review-ready-${name}-`));
  process.env.INVOKER_DB_DIR = dbDir;
  const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
  adapters.push(adapter);

  const orchestrator = new Orchestrator({
    persistence: adapter,
    messageBus: new NoopBus(),
    maxConcurrency: 10,
  });

  orchestrator.loadPlan({
    name: `upstream-${name}`,
    mergeMode: 'external_review',
    tasks: [{ id: 'upstream-leaf', description: 'upstream leaf' }],
  });
  const upstreamWfId = orchestrator.getWorkflowIds()[0]!;
  const upstreamLeafId = `${upstreamWfId}/upstream-leaf`;
  const upstreamMergeId = `__merge__${upstreamWfId}`;

  orchestrator.loadPlan({
    name: `downstream-${name}`,
    externalDependencies: [
      {
        workflowId: upstreamWfId,
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ],
    tasks: [{ id: 'downstream-leaf', description: 'downstream should start on upstream review_ready' }],
  });
  const downstreamWfId = orchestrator.getWorkflowIds()[1]!;
  const downstreamTaskId = `${downstreamWfId}/downstream-leaf`;

  adapter.updateTask(upstreamLeafId, {
    status: 'completed',
    execution: { completedAt: new Date() },
  });
  adapter.updateTask(upstreamMergeId, {
    status: 'running',
    execution: { startedAt: new Date(), lastHeartbeatAt: new Date() },
  });
  adapter.updateTask(downstreamTaskId, {
    status: 'blocked',
    execution: { blockedBy: `waiting on ${upstreamMergeId} (running)` },
  });
  orchestrator.syncAllFromDb();

  return { adapter, orchestrator, upstreamMergeId, downstreamTaskId };
}

afterEach(() => {
  while (adapters.length > 0) {
    adapters.pop()?.close();
  }
});

describe('review_ready external gate blocked downstream repro', () => {
  it('verifies the merge-runner-equivalent path unblocks already-blocked review_ready dependents', async () => {
    const bug = await createReproCase('bug-path');

    bug.orchestrator.setTaskReviewReady(bug.upstreamMergeId, {
      execution: {
        branch: 'feature/upstream',
        reviewUrl: 'https://example.invalid/pull/1',
        reviewId: '1',
        reviewStatus: 'Awaiting review',
      },
    });
    const bugStarted = bug.orchestrator.autoStartExternallyUnblockedReadyTasks();
    const bugDownstream = bug.orchestrator.getTask(bug.downstreamTaskId)!;
    const bugUpstream = bug.orchestrator.getTask(bug.upstreamMergeId)!;

    console.log(JSON.stringify({
      case: 'merge-runner-equivalent',
      upstreamStatus: bugUpstream.status,
      downstreamStatus: bugDownstream.status,
      downstreamBlockedBy: bugDownstream.execution.blockedBy,
      startedIds: bugStarted.map((task) => task.id),
    }));

    expect(bugUpstream.status).toBe('review_ready');
    expect(bugDownstream.status).toBe('running');
    expect(bugDownstream.execution.blockedBy).toBeUndefined();
    expect(bugStarted.map((task) => task.id)).toContain(bug.downstreamTaskId);

    const control = await createReproCase('control-path');
    const controlStarted = control.orchestrator.handleWorkerResponse({
      requestId: 'req-review-ready',
      actionId: control.upstreamMergeId,
      executionGeneration: control.orchestrator.getTask(control.upstreamMergeId)?.execution.generation ?? 0,
      status: 'review_ready',
      outputs: {
        exitCode: 0,
        summary: 'ready for review',
        branch: 'feature/upstream',
        reviewUrl: 'https://example.invalid/pull/1',
        reviewId: '1',
        reviewStatus: 'Awaiting review',
      },
    });
    const controlDownstream = control.orchestrator.getTask(control.downstreamTaskId)!;
    const controlUpstream = control.orchestrator.getTask(control.upstreamMergeId)!;

    console.log(JSON.stringify({
      case: 'handleWorkerResponse-control',
      upstreamStatus: controlUpstream.status,
      downstreamStatus: controlDownstream.status,
      downstreamBlockedBy: controlDownstream.execution.blockedBy ?? null,
      startedIds: controlStarted.map((task) => task.id),
    }));

    expect(controlUpstream.status).toBe('review_ready');
    expect(controlStarted.map((task) => task.id)).toContain(control.downstreamTaskId);
    expect(controlDownstream.status).toBe('running');
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

echo "PASS: verified setTaskReviewReady()+autoStartExternallyUnblockedReadyTasks starts an already-blocked review_ready dependent, matching handleWorkerResponse(review_ready)."
