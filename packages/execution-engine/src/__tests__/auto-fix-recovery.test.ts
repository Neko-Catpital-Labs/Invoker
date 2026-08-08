import { describe, expect, it, vi } from 'vitest';

import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import { collectValidatedAutoFixRecoveryCandidates } from '../auto-fix-recovery.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeFailedTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/build',
    description: 'build',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'pnpm build',
      ...(config ?? {}),
    },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/build',
      error: 'executor stopped heartbeating',
      failureClass: 'liveness_stall',
      ...(execution ?? {}),
    },
    taskStateVersion: 7,
    ...rest,
  } as TaskState;
}

describe('collectValidatedAutoFixRecoveryCandidates', () => {
  it('lists only failed liveness-classed tasks as candidates', () => {
    const task = makeFailedTask();
    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-1' ? [task] : [])),
      loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
      listWorkflowMutationIntents: vi.fn(() => []),
      logEvent: vi.fn(),
    };

    const candidates = collectValidatedAutoFixRecoveryCandidates({
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
    });

    expect(candidates).toEqual([]);
  });
});
