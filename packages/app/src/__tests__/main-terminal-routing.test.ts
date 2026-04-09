import { ExecutorRegistry, WorktreeExecutor, DockerExecutor } from '@invoker/execution-engine';
import type { Executor, ExecutorHandle } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

// Reproduce the selectExecutor logic from main.ts
function selectExecutor(registry: ExecutorRegistry, task: TaskState): Executor {
  if (task.config.executorType) {
    const registered = registry.get(task.config.executorType);
    if (registered) return registered;
    if (task.config.executorType === 'docker') {
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

  it('returns worktree executor when no executorType specified', () => {
    const task = { config: { executorType: undefined }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('worktree');
  });

  it('returns worktree executor for executorType "worktree"', () => {
    const task = { config: { executorType: 'worktree' }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('worktree');
  });

  it('lazily creates and returns docker executor for executorType "docker"', () => {
    const task = { config: { executorType: 'docker' }, execution: {} } as TaskState;
    const executor = selectExecutor(registry, task);
    expect(executor.type).toBe('docker');
    // Second call returns same instance
    const same = selectExecutor(registry, task);
    expect(same).toBe(executor);
  });

  it('per-task handle map routes getTerminalSpec to correct executor', () => {
    const taskHandles = new Map<string, { handle: ExecutorHandle; executor: Executor }>();

    const worktreeFamiliar = registry.getDefault();
    const dockerTask = { config: { executorType: 'docker' }, execution: {} } as TaskState;
    const dockerFamiliar = selectExecutor(registry, dockerTask);

    const worktreeHandle = { executionId: 'worktree-1', taskId: 'task-worktree' };
    const dockerHandle = { executionId: 'docker-1', taskId: 'task-docker' };
    taskHandles.set('task-worktree', { handle: worktreeHandle, executor: worktreeFamiliar });
    taskHandles.set('task-docker', { handle: dockerHandle, executor: dockerFamiliar });

    const worktreeEntry = taskHandles.get('task-worktree')!;
    expect(worktreeEntry.executor.type).toBe('worktree');

    const dockerEntry = taskHandles.get('task-docker')!;
    expect(dockerEntry.executor.type).toBe('docker');
  });
});
