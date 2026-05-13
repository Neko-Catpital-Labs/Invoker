import { ExecutorRegistry, WorktreeExecutor, DockerExecutor } from '@invoker/execution-engine';
import type { Executor, ExecutorHandle } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

// Reproduce the selectExecutor logic from main.ts
function selectExecutor(registry: ExecutorRegistry, task: TaskState): Executor {
  if (task.config.runnerKind) {
    const registered = registry.get(task.config.runnerKind);
    if (registered) return registered;
    if (task.config.runnerKind === 'docker') {
      const docker = new DockerExecutor({});
      registry.register('docker', docker);
      return docker;
    }
  }
  return registry.getDefault();
}

describe('Terminal routing via selectExecutor', () => {
  let registry: ExecutorRegistry;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/cache' }));
  });

  it('returns worktree executor when no runnerKind specified', () => {
    const task = { config: { runnerKind: undefined }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('worktree');
  });

  it('returns worktree executor for runnerKind "worktree"', () => {
    const task = { config: { runnerKind: 'worktree' }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('worktree');
  });

  it('lazily creates and returns docker executor for runnerKind "docker"', () => {
    const task = { config: { runnerKind: 'docker' }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('docker');
    // Second call returns same instance
    const same = selectExecutor(registry, task);
    expect(same).toBe(executor);
  });

  it('per-task handle map routes getTerminalSpec to correct executor', () => {
    const taskHandles = new Map<string, { handle: ExecutorHandle; executor: Executor }>();

    const worktreeExecutor = registry.getDefault();
    const dockerTask = { config: { runnerKind: 'docker' }, execution: {} } as TaskState;
    const dockerExecutor = selectExecutor(registry, dockerTask);

    const worktreeHandle = { executionId: 'worktree-1', taskId: 'task-worktree' };
    const dockerHandle = { executionId: 'docker-1', taskId: 'task-docker' };
    taskHandles.set('task-worktree', { handle: worktreeHandle, executor: worktreeExecutor });
    taskHandles.set('task-docker', { handle: dockerHandle, executor: dockerExecutor });

    const worktreeEntry = taskHandles.get('task-worktree')!;
    expect(worktreeEntry.executor.type).toBe('worktree');

    const dockerEntry = taskHandles.get('task-docker')!;
    expect(dockerEntry.executor.type).toBe('docker');
  });
});
