import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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
    execution: {
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T00:01:00Z'),
    },
    ...overrides,
  };
}

describe('headless query summary', () => {
  let mockDeps: HeadlessDeps;

  beforeEach(() => {
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
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      wireSlackBot: vi.fn(async () => ({})),
    };
    mockDeps.orchestrator.syncFromDb = vi.fn();
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [makeTask()]);
  });

  it('resolves without error', async () => {
    await expect(runHeadless(['query', 'summary'], mockDeps)).resolves.toBeUndefined();
  });

  it('outputs JSON with counts and status', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'summary', '--output', 'json'], mockDeps);
    const out = (stdout.mock.calls[0][0] as string);
    const parsed = JSON.parse(out);
    expect(parsed.workflowId).toBe('wf-1');
    expect(parsed.status).toBe('completed');
    expect(parsed.counts.completed).toBe(1);
    expect(parsed.failedTasks).toEqual([]);
    stdout.mockRestore();
  });

  it('includes failed task details in JSON output', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask({ id: 'wf-1/task-a', status: 'failed', execution: { error: 'exit code 1' } }),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'summary', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.counts.failed).toBe(1);
    expect(parsed.failedTasks[0].error).toBe('exit code 1');
    stdout.mockRestore();
  });

  it('outputs label as workflow status', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'summary', '--output', 'label'], mockDeps);
    expect(stdout.mock.calls[0][0]).toBe('completed\n');
    stdout.mockRestore();
  });

  it('throws when no workflows exist', async () => {
    (mockDeps.persistence.listWorkflows as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'summary'], mockDeps);
    expect(stdout.mock.calls[0][0]).toContain('No workflows found');
    stdout.mockRestore();
  });

  it('throws when specified workflow not found', async () => {
    await expect(
      runHeadless(['query', 'summary', 'wf-nonexistent'], mockDeps)
    ).rejects.toThrow(/not found/);
  });

  it('excludes merge nodes from counts', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask({ id: 'wf-1/task-a', status: 'completed' }),
      makeTask({ id: 'wf-1/__merge__wf-1', status: 'completed', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'summary', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.counts.completed).toBe(1);
    stdout.mockRestore();
  });
});
