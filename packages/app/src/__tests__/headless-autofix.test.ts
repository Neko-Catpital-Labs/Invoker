import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runHeadless } from '../headless.js';
import type { TaskState } from '@invoker/workflow-core';
import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'failed task',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', ...(config ?? {}) },
    execution: {
      error: 'boom',
      generation: 1,
      selectedAttemptId: 'attempt-1',
      ...(execution ?? {}),
    },
    taskStateVersion: 4,
    ...rest,
  };
}

describe('headless auto-fix cutover', () => {
  it('does not keep hidden auto-fix wiring in normal headless command paths', () => {
    const sources = [
      '../headless.ts',
      '../execution/task-runner-wiring.ts',
    ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

    for (const source of sources) {
      expect(source).not.toContain('wireHeadlessAutoFix');
      expect(source).not.toContain('onReviewGateCiFailure');
    }
  });
});

describe('headless worker autofix', () => {
  it('runs a one-shot scan under the single-instance lock and enqueues a bare restart first', async () => {
    const task = makeTask();
    const actions = new Map<string, WorkerActionRecord>();
    const enqueueWorkflowMutationIntent = vi.fn((
      _workflowId: string,
      _channel: string,
      _args: unknown[],
      _priority: WorkflowMutationPriority,
    ) => 1);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Point the worker lock at a throwaway home so the scan never touches the
    // real Invoker home (the door acquires/releases the cross-process lock).
    const homeRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-autofix-'));
    const previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = homeRoot;

    try {
      await runHeadless(['worker', 'autofix'], {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
        persistence: {
          listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
          loadTasks: vi.fn(() => [task]),
          loadTask: vi.fn(() => task),
          listWorkflowMutationIntents: vi.fn(() => []),
          getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
            actions.get(`${workerKind}:${externalKey}`)),
          upsertWorkerAction: vi.fn((writeAction: WorkerActionWrite) => {
            const key = `${writeAction.workerKind}:${writeAction.externalKey}`;
            const existing = actions.get(key);
            const now = '2026-01-01T00:00:00.000Z';
            const saved: WorkerActionRecord = {
              ...writeAction,
              attemptCount: writeAction.attemptCount ?? 0,
              createdAt: existing?.createdAt ?? writeAction.createdAt ?? now,
              updatedAt: writeAction.updatedAt ?? now,
            };
            actions.set(key, saved);
            return saved;
          }),
          logEvent: vi.fn(),
          enqueueWorkflowMutationIntent,
        },
        invokerConfig: { autoFixRetries: 3, autoFixAgent: 'codex' },
      } as any);
    } finally {
      write.mockRestore();
      if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
      else process.env.INVOKER_DB_DIR = previousDbDir;
      rmSync(homeRoot, { recursive: true, force: true });
    }

    expect(enqueueWorkflowMutationIntent).toHaveBeenCalledWith(
      'wf-1',
      'invoker:restart-task',
      ['wf-1/task-1'],
      'normal',
    );
  });

  it('lists worker kinds from the registry', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += chunk.toString();
      return true;
    });

    try {
      await runHeadless(['worker', 'list'], {} as any);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain('autofix');
  });

  it('rejects unknown worker kinds with a clear error', async () => {
    await expect(runHeadless(['worker', 'missing-kind'], {} as any)).rejects.toThrow(
      'Unknown worker kind: "missing-kind"',
    );
  });
});
