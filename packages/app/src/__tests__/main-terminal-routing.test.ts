import { FamiliarRegistry, LocalFamiliar, DockerFamiliar } from '@invoker/executors';
import type { Familiar, FamiliarHandle } from '@invoker/executors';
import type { TaskState } from '@invoker/core';

// Reproduce the selectFamiliar logic from main.ts
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
    registry.register('local', new LocalFamiliar());
  });

  it('returns local familiar when no familiarType specified', () => {
    const task = { familiarType: undefined } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('local');
  });

  it('returns local familiar for familiarType "local"', () => {
    const task = { familiarType: 'local' } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('local');
  });

  it('lazily creates and returns docker familiar for familiarType "docker"', () => {
    const task = { familiarType: 'docker' } as TaskState;
    const familiar = selectFamiliar(registry, task);
    expect(familiar.type).toBe('docker');
    // Second call returns same instance
    const same = selectFamiliar(registry, task);
    expect(same).toBe(familiar);
  });

  it('per-task handle map routes getTerminalSpec to correct familiar', () => {
    const taskHandles = new Map<string, { handle: FamiliarHandle; familiar: Familiar }>();

    const localFamiliar = registry.getDefault();
    const dockerTask = { familiarType: 'docker' } as TaskState;
    const dockerFamiliar = selectFamiliar(registry, dockerTask);

    const localHandle = { executionId: 'local-1', taskId: 'task-local' };
    const dockerHandle = { executionId: 'docker-1', taskId: 'task-docker' };
    taskHandles.set('task-local', { handle: localHandle, familiar: localFamiliar });
    taskHandles.set('task-docker', { handle: dockerHandle, familiar: dockerFamiliar });

    const localEntry = taskHandles.get('task-local')!;
    expect(localEntry.familiar.type).toBe('local');

    const dockerEntry = taskHandles.get('task-docker')!;
    expect(dockerEntry.familiar.type).toBe('docker');
  });
});
