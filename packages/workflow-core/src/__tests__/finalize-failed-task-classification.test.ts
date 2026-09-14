import { describe, it } from 'vitest';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('finalize failed task classification', () => {
  it('persists classifications for docker and local runner kinds', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    orchestrator.loadPlan({
      name: 'finalize-classification',
      onFinish: 'none',
      tasks: [
        { id: 'docker-task', description: 'docker', command: 'x', runnerKind: 'docker' },
        { id: 'local-task', description: 'local', command: 'x', runnerKind: 'worktree' },
      ],
    });
    const tasks = orchestrator.getAllTasks().filter((task) => !task.config.isMergeNode);
    const dockerTask = tasks.find((task) => task.id.endsWith('/docker-task'))!;
    const localTask = tasks.find((task) => task.id.endsWith('/local-task'))!;

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: dockerTask.id,
      status: 'failed',
      outputs: { exitCode: 1, error: 'No space left on device' },
    }));
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: localTask.id,
      status: 'failed',
      outputs: { exitCode: 255, error: 'SSH transport failed (exit 255): connection reset by peer.' },
    }));

    expect(persistence.getTaskEntry(dockerTask.id)?.task.execution.failureClass).toBe('ssh-disk-full');
    expect(persistence.getTaskEntry(localTask.id)?.task.execution.failureClass).toBe('ssh-transport-transient');
  });
});
