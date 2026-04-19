import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

const noopLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1/task-a',
    description: 'Do something',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1', executorType: 'worktree', isMergeNode: false },
    execution: {},
    ...overrides,
  };
}

describe('headless watch', () => {
  let mockDeps: HeadlessDeps;
  let bus: LocalBus;

  beforeEach(() => {
    bus = new LocalBus();
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: {} as Orchestrator,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => [
          { id: 'wf-1', name: 'My Workflow', status: 'completed', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:01:00Z' },
        ]),
        loadTasks: vi.fn(() => []),
      } as unknown as SQLiteAdapter,
      commandService: {} as CommandService,
      executorRegistry: {} as any,
      messageBus: bus as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      wireSlackBot: vi.fn(async () => ({})),
    };
    mockDeps.orchestrator.syncFromDb = vi.fn();
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [makeTask()]);
    mockDeps.orchestrator.getTask = vi.fn((id: string) => makeTask({ id }));
  });

  it('is classified as read-only', async () => {
    const { isHeadlessReadOnlyCommand, isHeadlessMutatingCommand } = await import('../headless-command-classification.js');
    expect(isHeadlessReadOnlyCommand(['watch'])).toBe(true);
    expect(isHeadlessMutatingCommand(['watch'])).toBe(false);
  });

  it('resolves when all tasks are already settled', async () => {
    await expect(runHeadless(['watch'], mockDeps)).resolves.toBeUndefined();
  });

  it('prints initial task snapshot', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['watch'], mockDeps);
    const output = stdout.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('wf-1/task-a');
    stdout.mockRestore();
  });

  it('prints final summary line', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['watch'], mockDeps);
    const output = stdout.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('[watch] done');
    stdout.mockRestore();
  });

  it('throws when specified workflow not found', async () => {
    await expect(runHeadless(['watch', 'wf-nonexistent'], mockDeps)).rejects.toThrow(/not found/);
  });

  it('prints no workflows message when none exist', async () => {
    (mockDeps.persistence.listWorkflows as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['watch'], mockDeps);
    expect(stdout.mock.calls[0][0]).toContain('No workflows found');
    stdout.mockRestore();
  });
});
