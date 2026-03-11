import { FamiliarRegistry, DockerFamiliar } from '@invoker/executors';
import type { Familiar, FamiliarHandle } from '@invoker/executors';
import type { TaskState } from '@invoker/core';

function stubFamiliar(type: string): Familiar {
  return {
    type,
    start: async () => ({ executionId: '', taskId: '' }),
    kill: async () => {},
    sendInput: () => {},
    onOutput: () => () => {},
    onComplete: () => () => {},
    getTerminalSpec: () => null,
    destroyAll: async () => {},
  };
}

function selectFamiliar(registry: FamiliarRegistry, task: TaskState): Familiar {
  if (task.familiarType) {
    const registered = registry.get(task.familiarType);
    if (registered) return registered;
    if (task.familiarType === 'docker') {
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
    registry.register('worktree', stubFamiliar('worktree'));
  });

  it('returns worktree familiar when no familiarType specified', () => {
    const task = { familiarType: undefined } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('worktree');
  });

  it('returns worktree familiar for familiarType "worktree"', () => {
    const task = { familiarType: 'worktree' } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('worktree');
  });

  it('lazily creates and returns docker familiar for familiarType "docker"', () => {
    const task = { familiarType: 'docker' } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('docker');
    const same = selectFamiliar(registry, task);
    expect(same).toBe(familiar);
  });

  it('per-task handle map routes getTerminalSpec to correct familiar', () => {
    const taskHandles = new Map<string, { handle: FamiliarHandle; familiar: Familiar }>();

    const worktreeFamiliar = registry.getDefault();
    const dockerTask = { familiarType: 'docker' } as TaskState;
    const dockerFamiliar = selectFamiliar(registry, dockerTask);

    const worktreeHandle = { executionId: 'wt-1', taskId: 'task-wt' };
    const dockerHandle = { executionId: 'docker-1', taskId: 'task-docker' };
    taskHandles.set('task-wt', { handle: worktreeHandle, familiar: worktreeFamiliar });
    taskHandles.set('task-docker', { handle: dockerHandle, familiar: dockerFamiliar });

    const wtEntry = taskHandles.get('task-wt')!;
    expect(wtEntry.familiar.type).toBe('worktree');

    const dockerEntry = taskHandles.get('task-docker')!;
    expect(dockerEntry.familiar.type).toBe('docker');
  });
});
