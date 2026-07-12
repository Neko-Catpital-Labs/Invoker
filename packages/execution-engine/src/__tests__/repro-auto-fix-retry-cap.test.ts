import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import { createAutoFixRecoveryTick } from '../auto-fix-recovery.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

function makeFailedTask(generation: number): TaskState {
  return {
    id: 'wf-1/build',
    description: 'build',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm build' },
    execution: {
      generation,
      selectedAttemptId: `attempt-${generation}`,
      branch: 'feature/build',
      // A deterministic pre-spawn failure (like a merge conflict) — no retry
      // count of bare re-runs can ever make it pass.
      error: 'Merge conflict merging experiment/wf-1/build',
    },
    taskStateVersion: generation,
  } as TaskState;
}

function makeStore() {
  const task = { current: makeFailedTask(2) };
  const actions = new Map<string, WorkerActionRecord>();
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-1' ? [task.current] : [])),
    loadTask: vi.fn(() => task.current),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const now = '2026-01-01T00:00:00.000Z';
      const saved: WorkerActionRecord = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { task, actions, store };
}

describe('auto-fix retry cap (incident 2026-07-12)', () => {
  it('caps total worker retries at the configured budget across generation bumps', async () => {
    const { task, store } = makeStore();
    const submit = vi.fn((_w: string, _p: WorkflowMutationPriority, _c: string, _a: unknown[]) => 99);
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    // Simulate the production loop: each retry re-runs the task, bumping the
    // generation + attempt lineage, then it deterministically fails again.
    for (let generation = 2; generation < 12; generation += 1) {
      task.current = makeFailedTask(generation);
      await tick({ reason: 'poll' } as never);
    }

    // Before the fix this looped forever (10 submissions here); the durable
    // per-task cap must hold total submissions to the configured budget of 3.
    expect(submit).toHaveBeenCalledTimes(3);
    expect(store.logEvent).toHaveBeenCalledWith(
      'wf-1/build',
      'debug.auto-fix',
      expect.objectContaining({ phase: 'worker-autofix-skip', reason: 'worker-retry-budget-exhausted' }),
    );
  });

  it('stays exhausted after an app restart (fresh in-memory ledger, same durable store)', async () => {
    const { task, store } = makeStore();
    const submit = vi.fn(() => 99);
    const drive = () =>
      createAutoFixRecoveryTick({
        store,
        submitter: { submit },
        logger,
        attemptLedger: createAutoFixAttemptLedger(),
        defaultAutoFixRetries: 3,
        getAutoFixAgent: () => 'codex',
      });

    let tick = drive();
    for (let generation = 2; generation < 6; generation += 1) {
      task.current = makeFailedTask(generation);
      await tick({ reason: 'poll' } as never);
    }
    expect(submit).toHaveBeenCalledTimes(3);

    // Restart: brand-new tick + brand-new in-memory ledger, but the same
    // durable worker_actions store. The cap must survive the restart.
    submit.mockClear();
    tick = drive();
    for (let generation = 6; generation < 10; generation += 1) {
      task.current = makeFailedTask(generation);
      await tick({ reason: 'poll' } as never);
    }
    expect(submit).not.toHaveBeenCalled();
  });
});
