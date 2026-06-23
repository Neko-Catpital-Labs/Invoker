import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runHeadless } from '../headless.js';
import { buildFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationPriority } from '@invoker/data-store';

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
      autoFixAttempts: 0,
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
  it('runs a one-shot scan and enqueues the normal fix command intent', async () => {
    const task = makeTask();
    const enqueueWorkflowMutationIntent = vi.fn((
      _workflowId: string,
      _channel: string,
      _args: unknown[],
      _priority: WorkflowMutationPriority,
    ) => 1);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await runHeadless(['worker', 'autofix'], {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
        persistence: {
          listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
          loadTasks: vi.fn(() => [task]),
          loadTask: vi.fn(() => task),
          listWorkflowMutationIntents: vi.fn(() => []),
          logEvent: vi.fn(),
          enqueueWorkflowMutationIntent,
        },
        invokerConfig: { autoFixRetries: 3, autoFixAgent: 'codex' },
      } as any);
    } finally {
      write.mockRestore();
    }

    expect(enqueueWorkflowMutationIntent).toHaveBeenCalledWith(
      'wf-1',
      'invoker:fix-with-agent',
      buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true }),
      'normal',
    );
  });
});
