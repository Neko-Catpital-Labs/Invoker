import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('finalize failed task classification', () => {
  it('classifies failures regardless of runner kind', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    orchestrator.loadPlan({
      name: 'runner-independent-classification',
      onFinish: 'none',
      tasks: [
        { id: 'docker-task', description: 'docker', command: 'x', runnerKind: 'docker' },
        { id: 'local-task', description: 'local', command: 'x' },
      ],
    });
    const dockerTaskId = orchestrator.getAllTasks().find((task) => task.id.endsWith('/docker-task'))!.id;
    const localTaskId = orchestrator.getAllTasks().find((task) => task.id.endsWith('/local-task'))!.id;

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: dockerTaskId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'No space left on device' },
    }));
    expect(orchestrator.getTask(dockerTaskId)!.execution.failureClass).toBe('ssh-disk-full');

    expect(persistence.getTaskEntry(dockerTaskId)!.task.execution.failureClass).toBe('ssh-disk-full');
    expect(orchestrator.getTask(localTaskId)!.status).toBe('running');
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: localTaskId,
      status: 'failed',
      outputs: { exitCode: 255, error: 'SSH transport failed (exit 255): connection reset by peer.' },
    }));
    expect(orchestrator.getTask(localTaskId)!.execution.failureClass).toBe('ssh-transport-transient');
    expect(persistence.getTaskEntry(localTaskId)!.task.execution.failureClass).toBe('ssh-transport-transient');
  });
});
