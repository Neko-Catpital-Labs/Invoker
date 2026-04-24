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

function makeWorkflow(id: string, status: 'completed' | 'failed' | 'running', overrides: Record<string, unknown> = {}) {
  return { id, name: `Workflow ${id}`, status, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:01:00Z', ...overrides };
}

function makeTask(wfId: string, status: string, description = 'Run tests') {
  return {
    id: `${wfId}/task-a`,
    description,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: wfId, isMergeNode: false },
    execution: {},
  };
}

describe('headless query stats', () => {
  let mockDeps: HeadlessDeps;

  beforeEach(() => {
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: {} as Orchestrator,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => [
          makeWorkflow('wf-1', 'completed'),
          makeWorkflow('wf-2', 'completed'),
          makeWorkflow('wf-3', 'failed'),
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
    mockDeps.orchestrator.getAllTasks = vi.fn(() => []);
  });

  it('resolves without error', async () => {
    await expect(runHeadless(['query', 'stats'], mockDeps)).resolves.toBeUndefined();
  });

  it('outputs correct counts in JSON', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.totalWorkflows).toBe(3);
    expect(parsed.completed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.running).toBe(0);
    stdout.mockRestore();
  });

  it('computes success rate correctly', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    // 2 completed out of 3 terminal = 66.67%
    expect(parsed.successRate).toBeCloseTo(66.67, 1);
    stdout.mockRestore();
  });

  it('outputs label as success rate percentage', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'label'], mockDeps);
    expect(stdout.mock.calls[0][0]).toMatch(/\d+\.\d+%\n/);
    stdout.mockRestore();
  });

  it('includes most failed tasks ranked by frequency', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn((wfId?: string) => {
      const id = (mockDeps.orchestrator.syncFromDb as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? 'wf-1';
      return [makeTask(id, 'failed', 'Run tests')] as any;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.mostFailedTasks.length).toBeGreaterThan(0);
    expect(parsed.mostFailedTasks[0].description).toBe('Run tests');
    expect(parsed.mostFailedTasks[0].failCount).toBeGreaterThan(0);
    stdout.mockRestore();
  });

  it('returns 100% success rate when all workflows completed', async () => {
    (mockDeps.persistence.listWorkflows as ReturnType<typeof vi.fn>).mockReturnValue([
      makeWorkflow('wf-1', 'completed'),
      makeWorkflow('wf-2', 'completed'),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.successRate).toBe(100);
    stdout.mockRestore();
  });

  it('returns 0% success rate when no terminal workflows', async () => {
    (mockDeps.persistence.listWorkflows as ReturnType<typeof vi.fn>).mockReturnValue([
      makeWorkflow('wf-1', 'running'),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.successRate).toBe(0);
    stdout.mockRestore();
  });

  it('omits avgDurationMs when no workflows have timestamps', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'stats', '--output', 'json'], mockDeps);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.avgDurationMs).toBeNull();
    stdout.mockRestore();
  });
});
