import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger, autoFixAttemptLedgerKeyFromTask } from '../auto-fix-attempt-ledger.js';
import {
  AUTO_FIX_RECREATE_CHANNEL,
  AUTO_FIX_WORKER_KIND,
  collectValidatedAutoFixRecoveryCandidates,
  createAutoFixRecoveryTick,
  shouldRecreateMergeGateInsteadOfAutoFix,
} from '../auto-fix-recovery.js';
import { autoFixBareRetryExternalKey } from '../auto-fix-retry-cap.js';
import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';

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

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(task = makeFailedTask()) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string, _args: unknown[]) => 99);
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const attemptLedger = createAutoFixAttemptLedger();
  return { tasks, actions, store, submit, attemptLedger };
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

  it('skips every persisted SSH infra failure class so autofix cannot race infra-repair', async () => {
    const { SSH_INFRA_FAILURE_CLASSES } = await import('@invoker/workflow-core');
    const { listAutoFixRecoveryScanCandidates } = await import('../auto-fix-recovery.js');

    for (const failureClass of SSH_INFRA_FAILURE_CLASSES) {
      const task = makeFailedTask({
        execution: {
          generation: 2,
          selectedAttemptId: 'attempt-1',
          branch: 'feature/build',
          error: `infra: ${failureClass}`,
          failureClass,
        },
      });
      const store = {
        listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
        loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-1' ? [task] : [])),
        loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
        listWorkflowMutationIntents: vi.fn(() => []),
        logEvent: vi.fn(),
      };
      const options = {
        store,
        submitter: { submit: vi.fn(() => 1) },
        logger,
        attemptLedger: createAutoFixAttemptLedger(),
        defaultAutoFixRetries: 3,
      };
      const scanned = listAutoFixRecoveryScanCandidates(options);
      // Scan may still list failed tasks; validation must drop all SSH infra classes.
      const validated = collectValidatedAutoFixRecoveryCandidates(options, scanned);
      expect(validated, failureClass).toEqual([]);
    }
  });

  it('skips admin-bypass-* workflows so normalize gates are not rubber-stamped', () => {
    const task = makeFailedTask({
      id: 'wf-admin/normalize',
      config: { workflowId: 'wf-admin', command: 'python3 scripts/mergify_admin_requeue_repair_normalize.py' },
      execution: {
        generation: 1,
        selectedAttemptId: 'attempt-1',
        error: 'blocked_invalid: Review Unit routing',
        failureClass: undefined,
      },
    });
    const store = {
      listWorkflows: vi.fn(() => [{
        id: 'wf-admin',
        name: 'admin-bypass-repair-check-pr-10514-build-artifacts-d1f1cf5',
      }]),
      loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-admin' ? [task] : [])),
      loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
      listWorkflowMutationIntents: vi.fn(() => []),
      logEvent: vi.fn(),
    };
    const options = {
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
    };

    expect(collectValidatedAutoFixRecoveryCandidates(options)).toEqual([]);
    expect(store.logEvent).toHaveBeenCalledWith(
      task.id,
      'debug.auto-fix',
      expect.objectContaining({ phase: 'worker-autofix-skip', reason: 'admin-bypass-excluded' }),
    );
  });
});

describe('shouldRecreateMergeGateInsteadOfAutoFix', () => {
  it('is false for non-merge tasks even with a missing workspace', () => {
    expect(shouldRecreateMergeGateInsteadOfAutoFix(makeFailedTask({
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        error: 'build failed',
      },
    }))).toBe(false);
  });

  it('is true when the merge-gate error already says to recreate the gate', () => {
    expect(shouldRecreateMergeGateInsteadOfAutoFix(makeFailedTask({
      id: '__merge__wf-1',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        workspacePath: '/tmp/does-not-matter',
        error: "Cannot apply a fix because this merge gate's saved workspace is missing or is not a git repository. Recreate this merge-gate task from a fresh base, then rerun the gate.",
      },
    }))).toBe(true);
  });

  it('is true when the merge-gate workspace path is missing', () => {
    expect(shouldRecreateMergeGateInsteadOfAutoFix(makeFailedTask({
      id: '__merge__wf-1',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        error: 'merge failed',
      },
    }))).toBe(true);
  });

  it('is true when the merge-gate workspace exists but is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-merge-nongit-'));
    try {
      expect(shouldRecreateMergeGateInsteadOfAutoFix(makeFailedTask({
        id: '__merge__wf-1',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: {
          generation: 2,
          selectedAttemptId: 'attempt-1',
          workspacePath: dir,
          error: 'merge failed',
        },
      }))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when the merge-gate workspace is a git worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-merge-git-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      expect(shouldRecreateMergeGateInsteadOfAutoFix(makeFailedTask({
        id: '__merge__wf-1',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: {
          generation: 2,
          selectedAttemptId: 'attempt-1',
          workspacePath: dir,
          error: 'merge conflict in packages/app/src/foo.ts',
        },
      }))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auto-fix recovery merge-gate recreate routing', () => {
  it('submits invoker:recreate-task instead of fix-with-agent for invalid merge workspaces', async () => {
    const mergeTask = makeFailedTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        workspacePath: '/tmp/invoker-empty-launch-placeholder',
        error: 'Unable to resolve merge worktree ref "plan/old-base"',
        failureClass: undefined,
      },
    });
    const harness = makeHarness(mergeTask);
    harness.actions.set(`${AUTO_FIX_WORKER_KIND}:${autoFixBareRetryExternalKey(mergeTask.id)}`, toRecord({
      id: `${AUTO_FIX_WORKER_KIND}:${autoFixBareRetryExternalKey(mergeTask.id)}`,
      workerKind: AUTO_FIX_WORKER_KIND,
      externalKey: autoFixBareRetryExternalKey(mergeTask.id),
      actionType: 'auto-retry',
      subjectType: 'task',
      subjectId: mergeTask.id,
      status: 'queued',
      attemptCount: 1,
      workflowId: 'wf-1',
      taskId: mergeTask.id,
    }));

    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    await tick({ reason: 'poll' } as never);

    expect(harness.submit).toHaveBeenCalledTimes(1);
    const [workflowId, priority, channel, args] = harness.submit.mock.calls[0]!;
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe(AUTO_FIX_RECREATE_CHANNEL);
    expect(args).toEqual([mergeTask.id]);
    expect(harness.attemptLedger.get(autoFixAttemptLedgerKeyFromTask(mergeTask))).toBe(0);
  });
});
