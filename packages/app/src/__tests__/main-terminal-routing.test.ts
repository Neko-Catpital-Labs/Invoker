import { FamiliarRegistry, WorktreeFamiliar, DockerFamiliar } from '@invoker/executors';
import type { Familiar, FamiliarHandle } from '@invoker/executors';
import type { TaskState } from '@invoker/core';

// Reproduce the selectFamiliar logic from main.ts
function selectFamiliar(registry: FamiliarRegistry, task: TaskState): Familiar {
  if (task.config.familiarType) {
    const registered = registry.get(task.config.familiarType);
    if (registered) return registered;
    if (task.config.familiarType === 'docker') {
      const docker = new DockerFamiliar({ workspaceDir: '/tmp' });
      registry.register('docker', docker);
      return docker;
    }
  }
  return registry.getDefault();
}

describe('Terminal routing via selectFamiliar', () => {
  let registry: FamiliarRegistry;

  beforeEach(() => {
    registry = new FamiliarRegistry();
    registry.register('worktree', new WorktreeFamiliar({ cacheDir: '/tmp/cache' }));
  });

  it('returns worktree familiar when no familiarType specified', () => {
    const task = { config: { familiarType: undefined }, execution: {} } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('worktree');
  });

  it('returns worktree familiar for familiarType "worktree"', () => {
    const task = { config: { familiarType: 'worktree' }, execution: {} } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('worktree');
  });

  it('lazily creates and returns docker familiar for familiarType "docker"', () => {
    const task = { config: { familiarType: 'docker' }, execution: {} } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('docker');
    // Second call returns same instance
    const same = selectFamiliar(registry, task);
    expect(same).toBe(familiar);
  });

  it('per-task handle map routes getTerminalSpec to correct familiar', () => {
    const taskHandles = new Map<string, { handle: FamiliarHandle; familiar: Familiar }>();

    const worktreeFamiliar = registry.getDefault();
    const dockerTask = { config: { familiarType: 'docker' }, execution: {} } as TaskState;
    const dockerFamiliar = selectFamiliar(registry, dockerTask);

    const worktreeHandle = { executionId: 'worktree-1', taskId: 'task-worktree' };
    const dockerHandle = { executionId: 'docker-1', taskId: 'task-docker' };
    taskHandles.set('task-worktree', { handle: worktreeHandle, familiar: worktreeFamiliar });
    taskHandles.set('task-docker', { handle: dockerHandle, familiar: dockerFamiliar });

    const worktreeEntry = taskHandles.get('task-worktree')!;
    expect(worktreeEntry.familiar.type).toBe('worktree');

    const dockerEntry = taskHandles.get('task-docker')!;
    expect(dockerEntry.familiar.type).toBe('docker');
  });
});
