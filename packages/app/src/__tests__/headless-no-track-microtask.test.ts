import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { headlessStartReady, headlessRetryTask } from '../headless-run-resume.js';
import type { HeadlessDeps } from '../headless-shared.js';

function makeRunningTask(id: string, workflowId: string): any {
  return {
    id,
    status: 'running',
    config: { workflowId },
    execution: {},
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('--no-track microtask dispatch (no deferRunnableTasks)', () => {
  let executeTasks: ReturnType<typeof vi.fn>;
  let deps: HeadlessDeps;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    executeTasks = vi.fn().mockResolvedValue(undefined);
    const noopLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => noopLogger),
    };
    deps = {
      logger: noopLogger as any,
      orchestrator: {} as any,
      persistence: {} as any,
      commandService: {} as any,
      executorRegistry: {} as any,
      messageBus: {} as any,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      noTrack: true,
      ownerTaskRunnerProvider: () => ({ executeTasks } as any),
    } as HeadlessDeps;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    stdout.mockRestore();
  });

  it('headlessStartReady dispatches runnable tasks as a microtask', async () => {
    const task = makeRunningTask('wf-1/task-1', 'wf-1');
    deps.orchestrator.syncAllFromDb = vi.fn();
    deps.orchestrator.getAllTasks = vi.fn(() => []);
    deps.orchestrator.getExecutableReadyTasks = vi.fn(() => []);
    deps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
    deps.orchestrator.startExecution = vi.fn(() => [task]);

    await headlessStartReady(['--no-track'], deps);
    await flushMicrotasks();

    expect(executeTasks).toHaveBeenCalledTimes(1);
    expect(executeTasks).toHaveBeenCalledWith([task]);
  });

  it('headlessRetryTask dispatches runnable tasks as a microtask', async () => {
    const task = makeRunningTask('wf-1/task-1', 'wf-1');
    deps.preemptTaskSubgraph = vi.fn(async () => {});
    deps.orchestrator.syncFromDb = vi.fn();
    deps.orchestrator.startExecution = vi.fn(() => []);
    deps.persistence.listWorkflows = vi.fn(() => [{
      id: 'wf-1',
      name: 'wf-1',
      generation: 0,
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);
    deps.persistence.loadTasks = vi.fn(() => [{
      id: 'wf-1/task-1',
      status: 'failed',
      config: { workflowId: 'wf-1' },
      execution: {},
    } as any]);
    deps.commandService.retryTask = vi.fn(async () => ({ ok: true as const, data: [task] }));

    await headlessRetryTask('wf-1/task-1', deps);
    await flushMicrotasks();

    expect(executeTasks).toHaveBeenCalledTimes(1);
    expect(executeTasks).toHaveBeenCalledWith([task]);
  });
});
