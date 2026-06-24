import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runHeadless } from '../headless.js';
import { buildFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationPriority } from '@invoker/data-store';
import { createWorkerRegistry, registerAutoFixWorker } from '@invoker/execution-engine';

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
  it('runs a one-shot scan under the single-instance lock and enqueues the normal fix command intent', async () => {
    const task = makeTask();
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
      'invoker:fix-with-agent',
      buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true }),
      'normal',
    );
  });

  it('lists worker kinds from the shared registry', async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await runHeadless(['worker', 'list'], {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
        persistence: {} as any,
        invokerConfig: {},
      } as any);
    } finally {
      write.mockRestore();
    }

    // The overview is sourced from the registry: every registered kind and its
    // note appears, so registering a worker surfaces it here without editing
    // the door.
    const output = chunks.join('');
    const registry = registerAutoFixWorker(createWorkerRegistry());
    expect(registry.list().length).toBeGreaterThan(0);
    for (const definition of registry.list()) {
      expect(output).toContain(definition.kind);
      expect(output).toContain(definition.note);
    }
  });

  it('rejects an unknown worker kind with a clear non-zero error', async () => {
    await expect(
      runHeadless(['worker', 'frobnicate'], {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
        persistence: {} as any,
        invokerConfig: {},
      } as any),
    ).rejects.toThrow('Unknown worker sub-command: "frobnicate"');
  });
});
